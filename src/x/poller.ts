/**
 * Polling worker (scheduler) — the bot's primary ingestion path.
 *
 * On a fixed cadence (`POLL_INTERVAL_SEC`) the poller:
 *
 *   1. Reads the persisted `since_id` cursor from the store.
 *   2. Fetches mentions newer than that cursor via the {@link XClient}.
 *   3. Feeds the batch through the reply pipeline ({@link processMentions}).
 *   4. Advances the cursor to the newest fetched mention — but only *after*
 *      the batch has been fully handled.
 *
 * Operational guarantees:
 *  - **No overlapping runs** — the next tick is scheduled only once the current
 *    one has fully settled, so a slow run (one that exceeds the interval) can
 *    never run concurrently with the next. This keeps cursor accounting and the
 *    pipeline's single-writer assumptions intact.
 *  - **Cursor safety** — the cursor advances strictly after the pipeline has
 *    processed the batch. If the fetch (or processing) throws, the cursor is
 *    left untouched so the same mentions are retried on the next tick. Per-
 *    mention failures are isolated *inside* the pipeline and recorded as
 *    `error` outcomes; they do not block cursor advancement, and the dedupe
 *    store prevents any double replies on a subsequent re-fetch.
 *  - **Rate-limit backoff** — the {@link XClient} already retries individual
 *    429s while honoring the reset window; if a request still surfaces a 429
 *    {@link XApiError} after exhausting retries, the poller waits a longer
 *    backoff interval before its next tick instead of hammering the API.
 *  - **Graceful start/stop** — `start()` is idempotent; `stop()` cancels any
 *    pending timer and awaits the in-flight tick before resolving, so callers
 *    (e.g. a SIGTERM handler) can drain cleanly.
 */
import type { BatchSummary, PipelineDeps } from "../pipeline/process.js";
import { processMentions } from "../pipeline/process.js";

import type { Mention } from "./client.js";
import { XApiError } from "./client.js";

/** Scheduling knobs for the poller (sourced from validated config). */
export interface PollerConfig {
  /** Seconds between the end of one tick and the start of the next. */
  pollIntervalSec: number;
  /**
   * Seconds to wait before the next tick after a rate-limit (HTTP 429) error
   * survives the client's own retries. Defaults to `pollIntervalSec` (i.e. a
   * normal-length pause) when unset.
   */
  rateLimitBackoffSec?: number;
}

/** Collaborators the poller drives. */
export interface PollerDeps {
  /**
   * Pre-built pipeline collaborators. The poller reads `client`, `store`, and
   * `logger` from this bundle (single source of truth) and passes the whole
   * bundle straight through to {@link processMentions}.
   */
  pipeline: PipelineDeps;
  /** Scheduling configuration. */
  config: PollerConfig;
}

/** A running poller; control its lifecycle and trigger manual ticks. */
export interface Poller {
  /**
   * Begin polling. Schedules an immediate first tick, then reschedules after
   * each tick settles. Idempotent — calling `start()` on an already-running
   * poller is a no-op (logged at warn level).
   */
  start(): void;
  /**
   * Stop polling. Cancels any pending timer and awaits the in-flight tick (if
   * any) so the process can drain cleanly. Resolves once fully stopped.
   */
  stop(): Promise<void>;
  /**
   * Run a single fetch → process → advance-cursor cycle and return its
   * {@link BatchSummary}, or `undefined` when there were no new mentions.
   *
   * Exposed for manual invocation and tests. Unlike the scheduled loop, this
   * propagates fetch/processing errors to the caller rather than catching them.
   */
  tick(): Promise<BatchSummary | undefined>;
}

/** True if `err` is a rate-limit (HTTP 429) error from the X client. */
function isRateLimit(err: unknown): boolean {
  return err instanceof XApiError && err.code === 429;
}

/**
 * Return the highest tweet ID among `mentions`.
 *
 * Tweet IDs are 64-bit snowflakes that exceed `Number.MAX_SAFE_INTEGER`, so
 * comparison is done with `BigInt` to avoid precision loss. The X API returns
 * mentions newest-first, but we never rely on that ordering here.
 */
function maxId(mentions: readonly Mention[]): string {
  return mentions.reduce(
    (max, mention) => (BigInt(mention.id) > BigInt(max) ? mention.id : max),
    mentions[0]!.id,
  );
}

/**
 * Create a {@link Poller} that ingests mentions on a fixed cadence.
 *
 * The returned poller is inert until {@link Poller.start} is called.
 *
 * @param deps Pipeline collaborators and scheduling configuration.
 */
export function createPoller(deps: PollerDeps): Poller {
  const { client, store, logger } = deps.pipeline;
  const intervalMs = deps.config.pollIntervalSec * 1_000;
  const rateLimitBackoffMs =
    (deps.config.rateLimitBackoffSec ?? deps.config.pollIntervalSec) * 1_000;

  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = true;

  async function tick(): Promise<BatchSummary | undefined> {
    const sinceId = store.getCursor();
    const mentions = await client.getMentions(sinceId);

    if (mentions.length === 0) {
      logger.debug({ stage: "poll", sinceId }, "no new mentions");
      return undefined;
    }

    logger.info({ stage: "poll", count: mentions.length, sinceId }, "fetched mentions");

    // Process the full batch first; only then advance the cursor. If this
    // throws, the cursor is left untouched and the batch is retried next tick.
    const summary = await processMentions(mentions, deps.pipeline);

    const cursor = maxId(mentions);
    store.setCursor(cursor);
    logger.info({ stage: "poll", cursor, ...counts(summary) }, "batch handled; cursor advanced");

    return summary;
  }

  /** Schedule the next tick after `delayMs`, unless the poller is stopped. */
  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(runScheduled, delayMs);
  }

  /**
   * Execute one scheduled tick, swallowing errors (a transient failure must
   * not kill the loop) and choosing the next delay based on the outcome.
   * Reschedules itself in `finally`, guaranteeing no overlapping runs.
   */
  function runScheduled(): void {
    timer = undefined;
    inFlight = (async () => {
      let nextDelayMs = intervalMs;
      try {
        await tick();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isRateLimit(err)) {
          nextDelayMs = rateLimitBackoffMs;
          logger.warn(
            { stage: "poll", err, backoffMs: nextDelayMs },
            `rate limited; backing off before next tick: ${message}`,
          );
        } else {
          logger.error({ stage: "poll", err }, `poll tick failed: ${message}`);
        }
      } finally {
        inFlight = undefined;
        schedule(nextDelayMs);
      }
    })();
  }

  return {
    start(): void {
      if (!stopped) {
        logger.warn({ stage: "poll" }, "poller already started");
        return;
      }
      stopped = false;
      logger.info(
        { stage: "poll", intervalMs, rateLimitBackoffMs },
        "poller started; running first tick",
      );
      schedule(0);
    },

    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (inFlight !== undefined) {
        await inFlight;
      }
      logger.info({ stage: "poll" }, "poller stopped");
    },

    tick,
  };
}

/** Extract just the aggregate counts from a batch summary (for logging). */
function counts(summary: BatchSummary): Omit<BatchSummary, "results"> {
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
