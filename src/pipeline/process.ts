/**
 * Reply pipeline orchestrator.
 *
 * Drives a single normalized mention through the full reply lifecycle:
 *
 *   filter -> generate -> safety -> post -> markReplied
 *
 * The orchestrator is deliberately *ingestion-agnostic*: it accepts an
 * already-normalized {@link PipelineMention} and a bundle of pre-built
 * collaborators ({@link PipelineDeps}), so both the polling worker (bd-120.9)
 * and the optional webhook receiver (bd-120.10) can reuse it unchanged.
 *
 * Operational guarantees:
 *  - **DRY_RUN** — when enabled the intended reply is logged but never posted,
 *    and the dedupe store is left untouched so a later real run still replies.
 *  - **MAX_REPLIES_PER_RUN** — caps the number of replies actually sent (or, in
 *    dry-run, *intended*) per batch; once the cap is hit, further reply-worthy
 *    mentions are reported as `throttled` without spending OpenAI tokens.
 *  - **Per-stage structured logging** — every stage emits a pino event tagged
 *    with the tweet ID, and generation events carry token usage.
 *  - **Fault isolation** — an error on one mention is caught, logged, and
 *    recorded as an `error` outcome; it never aborts the rest of the batch.
 */
import type { Logger } from "pino";

import type { GeneratedReply, ReplyContext, ReplyGenerator, TokenUsage } from "../ai/generate.js";
import type { Mention, XClient } from "../x/client.js";
import type { Store } from "../store/db.js";

import type { FilterOptions, SkipReason } from "./filter.js";
import { shouldReply } from "./filter.js";
import type { SafetyGuard, SafetyReason } from "./safety.js";

/**
 * A normalized mention ready for processing. Extends the X client's
 * {@link Mention} with the optional filter signals (`isRetweet`, `lang`) that
 * some ingestion paths can supply; when absent, the corresponding filter
 * checks are simply skipped.
 */
export interface PipelineMention extends Mention {
  /** True if the mention is a retweet (skipped by the filter). */
  isRetweet?: boolean;
  /** BCP-47 language code for the tweet, if known. */
  lang?: string;
}

/** Runtime knobs the orchestrator honors (sourced from validated config). */
export interface PipelineConfig {
  /** When true, log the intended reply but do not post or persist. */
  dryRun: boolean;
  /** Maximum replies posted (or, in dry-run, intended) per batch. */
  maxRepliesPerRun: number;
}

/** Pre-built collaborators the orchestrator drives. */
export interface PipelineDeps {
  /** Normalized inbound-mention filter configuration. */
  filterOptions: FilterOptions;
  /** Crypto-themed reply generator (OpenAI-backed). */
  generator: ReplyGenerator;
  /** Outbound safety guard (moderation + local guards). */
  safety: SafetyGuard;
  /** X API client used to post replies. */
  client: XClient;
  /** Persistence for reply dedupe (`hasReplied` / `markReplied`). */
  store: Store;
  /** Structured logger; per-mention child loggers are derived from it. */
  logger: Logger;
  /** Runtime behavior knobs. */
  config: PipelineConfig;
}

/**
 * Terminal disposition of a single mention.
 *
 *  - `replied`   — a reply was generated, passed safety, and was posted.
 *  - `dry-run`   — a reply was generated and passed safety but, under DRY_RUN,
 *                  was logged instead of posted (store left untouched).
 *  - `skipped`   — the filter rejected the mention before generation.
 *  - `blocked`   — the safety guard rejected the generated reply.
 *  - `throttled` — MAX_REPLIES_PER_RUN was already reached; not generated.
 *  - `error`     — an unexpected error was caught while processing.
 */
export type ProcessOutcome = "replied" | "dry-run" | "skipped" | "blocked" | "throttled" | "error";

/** Structured result for a single processed mention. */
export interface MentionResult {
  /** Tweet ID of the mention. */
  id: string;
  /** Terminal disposition. */
  outcome: ProcessOutcome;
  /** Machine-readable reason for `skipped` / `blocked` outcomes. */
  reason?: SkipReason | SafetyReason;
  /** ID of the posted reply (only for `replied`). */
  replyId?: string;
  /** Token usage for the generation, when one occurred. */
  usage?: TokenUsage;
  /** Error message for the `error` outcome (never includes secrets). */
  error?: string;
}

/** Aggregate summary of a processed batch. */
export interface BatchSummary {
  /** Total mentions seen. */
  processed: number;
  /** Count of `replied` outcomes. */
  replied: number;
  /** Count of `dry-run` outcomes. */
  dryRun: number;
  /** Count of `skipped` outcomes. */
  skipped: number;
  /** Count of `blocked` outcomes. */
  blocked: number;
  /** Count of `throttled` outcomes. */
  throttled: number;
  /** Count of `error` outcomes. */
  errors: number;
  /** Per-mention results, in input order. */
  results: MentionResult[];
}

/** Build the generation context from a normalized mention. */
function toReplyContext(mention: PipelineMention): ReplyContext {
  return {
    tweetText: mention.text,
    ...(mention.authorUsername !== undefined ? { authorUsername: mention.authorUsername } : {}),
    ...(mention.inReplyToText !== undefined ? { inReplyToText: mention.inReplyToText } : {}),
  };
}

/**
 * Process a single normalized mention through the full pipeline.
 *
 * The `budget` callback gates reply attempts against the run-wide throttle: it
 * is consulted *after* the filter passes (so non-reply mentions never consume
 * budget) and *before* generation (so throttled mentions never spend tokens).
 * It returns true and reserves a slot when budget remains, false otherwise.
 *
 * This function never throws: any error is caught, logged, and returned as an
 * `error` {@link MentionResult} so the batch loop can continue.
 *
 * @param mention The normalized mention to process.
 * @param deps Pre-built collaborators and runtime config.
 * @param reserveReplySlot Throttle gate; returns false when the cap is reached.
 */
export async function processMention(
  mention: PipelineMention,
  deps: PipelineDeps,
  reserveReplySlot: () => boolean,
): Promise<MentionResult> {
  const { filterOptions, generator, safety, client, store, config } = deps;
  const log = deps.logger.child({ tweetId: mention.id, authorId: mention.authorId });

  try {
    // 1. Filter — cheap rejection before any token spend.
    const decision = shouldReply(mention, filterOptions, store);
    if (!decision.reply) {
      log.info({ stage: "filter", outcome: "skipped", reason: decision.reason }, "mention skipped");
      return { id: mention.id, outcome: "skipped", reason: decision.reason };
    }

    // 2. Throttle — reserve a reply slot before spending OpenAI tokens.
    if (!reserveReplySlot()) {
      log.info(
        { stage: "throttle", outcome: "throttled" },
        "reply throttled (max per run reached)",
      );
      return { id: mention.id, outcome: "throttled" };
    }

    // 3. Generate the candidate reply.
    const generated: GeneratedReply = await generator.generate(toReplyContext(mention));
    log.info(
      {
        stage: "generate",
        truncated: generated.truncated,
        usage: generated.usage,
      },
      "reply generated",
    );

    // 4. Safety — final outbound gate (moderation + local guards).
    const verdict = await safety.check(generated.text);
    if (!verdict.ok) {
      log.warn(
        { stage: "safety", outcome: "blocked", reason: verdict.reason, usage: generated.usage },
        "reply blocked by safety guard",
      );
      return {
        id: mention.id,
        outcome: "blocked",
        reason: verdict.reason,
        usage: generated.usage,
      };
    }

    // 5a. DRY_RUN — log the intended reply, do not post, do not persist.
    if (config.dryRun) {
      log.info(
        { stage: "post", outcome: "dry-run", replyText: verdict.text, usage: generated.usage },
        "DRY_RUN: intended reply (not posted)",
      );
      return { id: mention.id, outcome: "dry-run", usage: generated.usage };
    }

    // 5b. Post the reply, then persist the dedupe marker.
    const posted = await client.reply(verdict.text, mention.id);
    store.markReplied(mention.id);
    log.info(
      { stage: "post", outcome: "replied", replyId: posted.id, usage: generated.usage },
      "reply posted",
    );

    return {
      id: mention.id,
      outcome: "replied",
      replyId: posted.id,
      usage: generated.usage,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ stage: "error", err: error }, `mention processing failed: ${message}`);
    return { id: mention.id, outcome: "error", error: message };
  }
}

/**
 * Process a batch of normalized mentions, isolating per-mention failures and
 * enforcing the run-wide reply throttle.
 *
 * Mentions are processed sequentially (the X write path is rate-limited, and
 * sequential processing keeps the throttle accounting and logs deterministic).
 * A single shared counter caps reply attempts at `MAX_REPLIES_PER_RUN`.
 *
 * @param mentions Normalized mentions in the order they should be considered.
 * @param deps Pre-built collaborators and runtime config.
 * @returns A {@link BatchSummary} with per-mention results and aggregate counts.
 */
export async function processMentions(
  mentions: readonly PipelineMention[],
  deps: PipelineDeps,
): Promise<BatchSummary> {
  const { maxRepliesPerRun, dryRun } = deps.config;

  let repliesUsed = 0;
  const reserveReplySlot = (): boolean => {
    if (repliesUsed >= maxRepliesPerRun) return false;
    repliesUsed += 1;
    return true;
  };

  deps.logger.info(
    { stage: "batch", count: mentions.length, maxRepliesPerRun, dryRun },
    "processing mention batch",
  );

  const results: MentionResult[] = [];
  for (const mention of mentions) {
    results.push(await processMention(mention, deps, reserveReplySlot));
  }

  const summary: BatchSummary = {
    processed: results.length,
    replied: results.filter((r) => r.outcome === "replied").length,
    dryRun: results.filter((r) => r.outcome === "dry-run").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    blocked: results.filter((r) => r.outcome === "blocked").length,
    throttled: results.filter((r) => r.outcome === "throttled").length,
    errors: results.filter((r) => r.outcome === "error").length,
    results,
  };

  deps.logger.info({ stage: "batch", ...summaryCounts(summary) }, "mention batch complete");

  return summary;
}

/** Extract just the aggregate counts (omit the per-mention array) for logging. */
function summaryCounts(summary: BatchSummary): Omit<BatchSummary, "results"> {
  return {
    processed: summary.processed,
    replied: summary.replied,
    dryRun: summary.dryRun,
    skipped: summary.skipped,
    blocked: summary.blocked,
    throttled: summary.throttled,
    errors: summary.errors,
  };
}
