/**
 * Outbound reply safety guardrails.
 *
 * The generation layer ({@link ../ai/generate}) only shapes tone and length;
 * it deliberately does *not* enforce content safety. This module is the
 * final gate every generated reply must pass before it can be posted, and it
 * lives in code (not just the persona prompt) so a misconfigured or adversarial
 * persona can never bypass it.
 *
 * It enforces, in order:
 *  1. OpenAI Moderation — hard block on any flagged category.
 *  2. Financial-advice handling — block egregious "guaranteed returns" style
 *     phrasing, and append a short disclaimer when the reply merely touches on
 *     buying/selling/investing.
 *  3. Profanity / spam heuristics — block obvious slurs and spammy shapes.
 *  4. Hard char-limit re-enforcement — any text we modified is re-trimmed to
 *     X's 280-character ceiling.
 *
 * The public surface is intentionally tiny: callers get back a
 * {@link SafetyResult} of `{ ok, text, reason? }` and never have to know which
 * specific check fired beyond the machine-readable {@link SafetyReason}.
 */
import OpenAI from "openai";

import { enforceLength } from "../ai/generate.js";
import type { Config } from "../config.js";

/** Why a reply was blocked. `undefined` reason means "ok". */
export type SafetyReason = "moderation-flagged" | "financial-advice" | "profanity" | "spam";

/** Outcome of running a generated reply through the safety guard. */
export interface SafetyResult {
  /** Whether the reply is safe to post. */
  ok: boolean;
  /**
   * The (possibly modified) reply text. When `ok` is true this is the text to
   * post — it may differ from the input (e.g. a disclaimer was appended). When
   * `ok` is false this is the original input, unmodified, for logging.
   */
  text: string;
  /** Populated when `ok` is false. */
  reason?: SafetyReason;
}

/** Runs the safety guardrails against generated reply text. */
export interface SafetyGuard {
  /**
   * Evaluate a single generated reply.
   *
   * @param text The candidate reply produced by the generation layer.
   * @returns A {@link SafetyResult}; on success `text` is the post-ready reply.
   */
  check(text: string): Promise<SafetyResult>;
}

/**
 * Short, appended when a reply touches on buying/selling/investing but is not
 * otherwise prohibited. Kept terse so it costs as few of the 280 chars as
 * possible.
 */
export const DISCLAIMER = "Not financial advice.";

/** Moderation model used for the outbound content check. */
const MODERATION_MODEL = "omni-moderation-latest";

/**
 * Phrasing that is never acceptable regardless of disclaimer — promises of
 * risk-free, guaranteed, or get-rich-quick outcomes. Matching any of these
 * blocks the reply outright.
 */
const PROHIBITED_ADVICE_PATTERNS: readonly RegExp[] = [
  /\bguaranteed\b[^.!?]{0,30}\b(?:returns?|profits?|gains?|money|win|wins?)\b/i,
  /\brisk[-\s]?free\b/i,
  /\bcan'?t\s+(?:lose|miss)\b/i,
  /\bcannot\s+(?:lose|miss)\b/i,
  /\bget\s+rich\s+quick\b/i,
  /\b(?:100|[1-9]\d{2,})x\s+guaranteed\b/i,
  /\bguaranteed\s+to\s+(?:moon|pump|double|triple|10x|moonshot)\b/i,
];

/**
 * Cues that the reply is giving (or strongly implying) a financial action.
 * These don't block — they trigger an appended {@link DISCLAIMER}.
 */
const ADVICE_CUE_PATTERNS: readonly RegExp[] = [
  /\byou\s+should\s+(?:buy|sell|invest|hodl|ape|short|long)\b/i,
  /\b(?:buy|sell)\s+(?:now|today|the\s+dip)\b/i,
  /\bape\s+in\b/i,
  /\bload\s+up\b/i,
  /\b(?:buy|sell|invest|hold|hodl|short|long|stake|trade)\b[^.!?]{0,30}\b(?:bitcoin|btc|ethereum|eth|crypto|coin|token|altcoin|\$[a-z]{2,6})\b/i,
  /\b(?:to\s+the\s+moon|going\s+to\s+moon|moonshot|pump\s+it)\b/i,
];

/**
 * A deliberately small, code-level slur/profanity blocklist. This is a
 * defense-in-depth backstop *behind* OpenAI Moderation (which catches the long
 * tail); it exists so the most egregious tokens are blocked even if the
 * moderation call is unavailable. Word-boundary matched, case-insensitive.
 */
const PROFANITY_PATTERNS: readonly RegExp[] = [
  /\bfuck/i,
  /\bshit\b/i,
  /\bcunt\b/i,
  /\bbitch\b/i,
  /\basshole\b/i,
  /\bn[i1]gg(?:er|a)\b/i,
  /\bfagg?ot\b/i,
  /\bretard\b/i,
];

/** Returns true if `text` contains never-acceptable financial-advice phrasing. */
export function hasProhibitedAdvice(text: string): boolean {
  return PROHIBITED_ADVICE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Returns true if `text` implies a financial action and so needs a disclaimer. */
export function needsDisclaimer(text: string): boolean {
  return ADVICE_CUE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Returns true if `text` contains blocked profanity/slurs. */
export function hasProfanity(text: string): boolean {
  return PROFANITY_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Cheap structural spam heuristics. Flags replies that look like link/hashtag
 * spam or keyboard-mash rather than a genuine on-brand reply.
 */
export function looksLikeSpam(text: string): boolean {
  const urls = text.match(/https?:\/\/\S+/gi) ?? [];
  if (urls.length >= 2) return true;

  const hashtags = text.match(/#[\w]+/g) ?? [];
  if (hashtags.length > 5) return true;

  const mentions = text.match(/@[\w]+/g) ?? [];
  if (mentions.length > 5) return true;

  // Long runs of a single repeated character (e.g. "!!!!!!!!", "aaaaaaaa").
  if (/(.)\1{7,}/.test(text)) return true;

  // A reply that is almost entirely a single URL with little else to say.
  if (urls.length === 1) {
    const withoutUrl = text.replace(urls[0], "").trim();
    if (withoutUrl.length < 10) return true;
  }

  return false;
}

/**
 * Append {@link DISCLAIMER} to `text` if it isn't already present. Adds a
 * leading space (or newline-free separator) so the result reads naturally.
 */
export function appendDisclaimer(text: string): string {
  const trimmed = text.trim();
  if (trimmed.toLowerCase().includes(DISCLAIMER.toLowerCase())) {
    return trimmed;
  }
  return `${trimmed} ${DISCLAIMER}`;
}

/**
 * Run the local (non-network) guardrails: prohibited advice, profanity, spam,
 * and disclaimer insertion. Returns the post-ready result *without* the
 * moderation network call, so it can be unit-tested in isolation and reused by
 * {@link createSafetyGuard} after moderation passes.
 *
 * Char-limit re-enforcement happens here, last, so any disclaimer we appended
 * is guaranteed to fit within {@link MAX_TWEET_CHARS}.
 */
export function applyLocalGuards(text: string): SafetyResult {
  const original = text.trim();

  if (hasProhibitedAdvice(original)) {
    return { ok: false, text: original, reason: "financial-advice" };
  }

  if (hasProfanity(original)) {
    return { ok: false, text: original, reason: "profanity" };
  }

  if (looksLikeSpam(original)) {
    return { ok: false, text: original, reason: "spam" };
  }

  const withDisclaimer = needsDisclaimer(original) ? appendDisclaimer(original) : original;

  // Re-enforce the hard char limit after any modification.
  const { text: bounded } = enforceLength(withDisclaimer);

  return { ok: true, text: bounded };
}

/**
 * Create a {@link SafetyGuard} backed by the OpenAI Moderation API plus the
 * local heuristic guards.
 *
 * Moderation runs first (fail-closed: any flagged category blocks the reply).
 * If a moderation call throws, we do *not* silently allow the text — the error
 * propagates so the caller can decide how to handle an outage rather than
 * posting unvetted content.
 *
 * @param config Validated app configuration (supplies the OpenAI key).
 * @param deps Optional injection seam (preconstructed client for testing).
 */
export function createSafetyGuard(config: Config, deps: { client?: OpenAI } = {}): SafetyGuard {
  const client = deps.client ?? new OpenAI({ apiKey: config.OPENAI_API_KEY });

  return {
    async check(text: string): Promise<SafetyResult> {
      const candidate = text.trim();

      const moderation = await client.moderations.create({
        model: MODERATION_MODEL,
        input: candidate,
      });

      if (moderation.results.some((result) => result.flagged)) {
        return { ok: false, text: candidate, reason: "moderation-flagged" };
      }

      return applyLocalGuards(candidate);
    },
  };
}
