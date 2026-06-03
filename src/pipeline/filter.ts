/**
 * Inbound mention filtering.
 *
 * Decides which mentions are worth a reply *before* spending OpenAI tokens or
 * making a write call. The core {@link shouldReply} predicate is pure and
 * side-effect free: it reads (never writes) the dedupe store and returns a
 * structured decision with a machine-readable {@link SkipReason}, so callers
 * can log exactly why a mention was dropped.
 *
 * Filtering is intentionally cheap: own-tweet/retweet/blocklist/language checks
 * are constant-time, and the dedupe lookup is a single indexed query.
 */
import type { Config } from "../config.js";

/** Why a mention was skipped. `undefined` decision means "reply". */
export type SkipReason =
  | "own-tweet"
  | "retweet"
  | "already-replied"
  | "blocked-user"
  | "unsupported-language";

/**
 * Minimal mention shape the filter needs. Compatible with the richer `Mention`
 * produced by the X client; `isRetweet` and `lang` are optional and, when
 * absent, their respective checks are simply skipped.
 */
export interface FilterInput {
  /** Tweet ID of the mention. */
  id: string;
  /** Numeric user ID of the author. */
  authorId: string;
  /** Author handle without the leading `@`, if known. */
  authorUsername?: string;
  /** True if the mention is a retweet (not an original/reply tweet). */
  isRetweet?: boolean;
  /** BCP-47 language code reported for the tweet, if known. */
  lang?: string;
}

/** Resolved, normalized filter configuration. */
export interface FilterOptions {
  /** The bot's own user ID — its own tweets are always skipped. */
  botUserId: string;
  /** Blocked numeric user IDs. */
  blockedUserIds: ReadonlySet<string>;
  /** Blocked handles (lowercased, no leading `@`). */
  blockedUsernames: ReadonlySet<string>;
  /**
   * Allowed language codes (lowercased). When empty, all languages are
   * allowed; when non-empty, mentions in other languages are skipped.
   */
  allowedLanguages: ReadonlySet<string>;
}

/** The only store capability the filter needs (read-only dedupe lookup). */
export interface ReplyDedupe {
  /** True if we've already replied to the given source tweet. */
  hasReplied(tweetId: string): boolean;
}

/** Outcome of evaluating a single mention. */
export interface FilterDecision {
  /** Whether the mention should receive a reply. */
  reply: boolean;
  /** Populated when `reply` is false. */
  reason?: SkipReason;
}

const REPLY: FilterDecision = { reply: true };

/**
 * Parse a comma-separated list into trimmed, non-empty, lowercased entries.
 */
function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Build normalized {@link FilterOptions} from validated config.
 *
 * Blocklist entries that are all digits are treated as user IDs; everything
 * else is treated as a handle (a leading `@` is stripped).
 */
export function buildFilterOptions(config: Config): FilterOptions {
  const blockedUserIds = new Set<string>();
  const blockedUsernames = new Set<string>();

  for (const entry of parseCsv(config.BLOCKLIST)) {
    if (/^\d+$/.test(entry)) {
      blockedUserIds.add(entry);
    } else {
      blockedUsernames.add(entry.replace(/^@/, ""));
    }
  }

  return {
    botUserId: config.BOT_USER_ID,
    blockedUserIds,
    blockedUsernames,
    allowedLanguages: new Set(parseCsv(config.ALLOWED_LANGUAGES)),
  };
}

/**
 * Decide whether a mention deserves a reply.
 *
 * Pure and side-effect free: the only external read is `store.hasReplied`.
 * Checks are ordered cheapest-first; the first failing check wins and its
 * {@link SkipReason} is returned.
 *
 * @param mention The incoming mention to evaluate.
 * @param options Normalized filter configuration (see {@link buildFilterOptions}).
 * @param store Read-only dedupe lookup.
 */
export function shouldReply(
  mention: FilterInput,
  options: FilterOptions,
  store: ReplyDedupe,
): FilterDecision {
  // 1. Never reply to our own tweets.
  if (mention.authorId === options.botUserId) {
    return { reply: false, reason: "own-tweet" };
  }

  // 2. Skip retweets — there's nothing original to engage with.
  if (mention.isRetweet === true) {
    return { reply: false, reason: "retweet" };
  }

  // 3. Skip blocked users (by ID or handle).
  const handle = mention.authorUsername?.toLowerCase();
  if (
    options.blockedUserIds.has(mention.authorId) ||
    (handle !== undefined && options.blockedUsernames.has(handle))
  ) {
    return { reply: false, reason: "blocked-user" };
  }

  // 4. Optional language gate.
  if (options.allowedLanguages.size > 0) {
    const lang = mention.lang?.toLowerCase();
    if (lang === undefined || !options.allowedLanguages.has(lang)) {
      return { reply: false, reason: "unsupported-language" };
    }
  }

  // 5. Skip mentions we've already replied to (cheapest external read last).
  if (store.hasReplied(mention.id)) {
    return { reply: false, reason: "already-replied" };
  }

  return REPLY;
}
