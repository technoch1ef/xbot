/**
 * Thin wrapper over `twitter-api-v2` exposing only the X (Twitter) operations
 * the bot needs: reading new mentions and posting replies.
 *
 * Authentication uses OAuth 1.0a user context, which authorizes both the read
 * (mentions timeline) and write (reply) endpoints used here.
 *
 * Rate limits: X returns HTTP 429 when a window is exhausted. Every request is
 * wrapped in a retry that honors the `x-rate-limit-reset` header (surfaced by
 * the library as `error.rateLimit.reset`, an epoch-seconds timestamp). When a
 * reset time is available we sleep until then; otherwise we fall back to
 * capped exponential backoff. Non-429 errors are never swallowed — they
 * propagate to the caller after being wrapped in a typed {@link XApiError}.
 */
import { TwitterApi, ApiResponseError, type TweetV2, type UserV2 } from "twitter-api-v2";

import type { Config } from "../config.js";

/** A mention of the bot, enriched with author and reply-context metadata. */
export interface Mention {
  /** Tweet ID of the mention. */
  id: string;
  /** Raw tweet text. */
  text: string;
  /** Numeric user ID of the mention's author. */
  authorId: string;
  /** `@handle` of the author (without the leading `@`), if resolvable. */
  authorUsername?: string;
  /** Root conversation ID this mention belongs to, if provided by the API. */
  conversationId?: string;
  /** ID of the tweet this mention is replying to, if it is itself a reply. */
  inReplyToTweetId?: string;
  /** Text of the tweet being replied to, when included by the API. */
  inReplyToText?: string;
}

/** Result of a successful reply post. */
export interface ReplyResult {
  /** Tweet ID of the newly created reply. */
  id: string;
  /** Text of the newly created reply, as accepted by the API. */
  text: string;
}

/** The minimal X surface the bot depends on. */
export interface XClient {
  /**
   * Fetch mentions of the bot newer than `sinceId` (exclusive).
   *
   * @param sinceId Only return mentions with an ID greater than this. Omit on
   *   the first run to fetch the most recent page.
   * @returns Mentions in API order (newest first), each enriched with author
   *   and reply-context fields where available.
   */
  getMentions(sinceId?: string): Promise<Mention[]>;

  /**
   * Post a reply to an existing tweet.
   *
   * @param text Reply body.
   * @param inReplyToTweetId ID of the tweet being replied to.
   * @returns The created reply's ID and text.
   */
  reply(text: string, inReplyToTweetId: string): Promise<ReplyResult>;
}

/** Typed error surfaced for non-retryable X API failures. */
export class XApiError extends Error {
  /** HTTP status code, when known. */
  readonly code?: number;

  constructor(message: string, options?: { code?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "XApiError";
    this.code = options?.code;
  }
}

/** Tuning knobs for rate-limit retry behavior. */
export interface RetryOptions {
  /** Maximum number of 429 retries before giving up. Default 5. */
  maxRetries: number;
  /** Base delay (ms) for exponential backoff when no reset header is present. */
  baseDelayMs: number;
  /** Upper bound (ms) on any single backoff wait. */
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

/**
 * Fields requested for mentions so we can build {@link Mention} context:
 * author, conversation root, and any referenced (replied-to) tweet.
 */
const MENTION_FIELDS = {
  expansions: "author_id,referenced_tweets.id,referenced_tweets.id.author_id",
  "tweet.fields": "created_at,conversation_id,in_reply_to_user_id,referenced_tweets",
  "user.fields": "username,name",
  max_results: 100,
};

/** Sleep helper. Exposed via the options seam for tests/injection. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an {@link XClient} backed by `twitter-api-v2`, authenticated with the
 * OAuth 1.0a user-context credentials in `config`.
 *
 * @param config Validated app configuration (see {@link Config}).
 * @param deps Optional injection seams for testing (sleep, retry tuning, and a
 *   preconstructed `TwitterApi`).
 */
export function createXClient(
  config: Config,
  deps: {
    api?: TwitterApi;
    sleep?: (ms: number) => Promise<void>;
    retry?: Partial<RetryOptions>;
  } = {},
): XClient {
  const api =
    deps.api ??
    new TwitterApi({
      appKey: config.X_APP_KEY,
      appSecret: config.X_APP_SECRET,
      accessToken: config.X_ACCESS_TOKEN,
      accessSecret: config.X_ACCESS_SECRET,
    });

  const sleep = deps.sleep ?? defaultSleep;
  const retry: RetryOptions = { ...DEFAULT_RETRY, ...deps.retry };

  return {
    async getMentions(sinceId?: string): Promise<Mention[]> {
      const paginator = await withRateLimitRetry(
        () =>
          api.v2.userMentionTimeline(config.BOT_USER_ID, {
            ...MENTION_FIELDS,
            ...(sinceId ? { since_id: sinceId } : {}),
          }),
        { sleep, retry, op: "getMentions" },
      );

      const includes = paginator.includes;
      return paginator.tweets.map((tweet): Mention => {
        const author: UserV2 | undefined = includes.author(tweet);
        const repliedTo: TweetV2 | undefined = includes.repliedTo(tweet);
        const inReplyToTweetId = tweet.referenced_tweets?.find(
          (ref) => ref.type === "replied_to",
        )?.id;

        return {
          id: tweet.id,
          text: tweet.text,
          authorId: tweet.author_id ?? "",
          authorUsername: author?.username,
          conversationId: tweet.conversation_id,
          inReplyToTweetId,
          inReplyToText: repliedTo?.text,
        };
      });
    },

    async reply(text: string, inReplyToTweetId: string): Promise<ReplyResult> {
      const result = await withRateLimitRetry(() => api.v2.reply(text, inReplyToTweetId), {
        sleep,
        retry,
        op: "reply",
      });

      return { id: result.data.id, text: result.data.text };
    },
  };
}

/**
 * Invoke `fn`, retrying on HTTP 429 while honoring the rate-limit reset window.
 *
 * Behavior:
 *  - On a 429 with a `rateLimit.reset` (epoch seconds), sleep until that time
 *    (plus a small buffer) before retrying.
 *  - On a 429 without reset metadata, sleep using capped exponential backoff.
 *  - After `retry.maxRetries` exhausted 429s, throw {@link XApiError} (429).
 *  - Any non-429 {@link ApiResponseError} is rethrown as {@link XApiError}
 *    carrying the HTTP code; unknown errors are rethrown unchanged.
 */
async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  ctx: { sleep: (ms: number) => Promise<void>; retry: RetryOptions; op: string },
): Promise<T> {
  const { sleep, retry, op } = ctx;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ApiResponseError && error.code === 429) {
        if (attempt >= retry.maxRetries) {
          throw new XApiError(
            `X API rate limit exceeded for ${op} after ${retry.maxRetries} retries`,
            { code: 429, cause: error },
          );
        }
        await sleep(rateLimitWaitMs(error, attempt, retry));
        continue;
      }

      if (error instanceof ApiResponseError) {
        throw new XApiError(`X API request failed for ${op} (HTTP ${error.code})`, {
          code: error.code,
          cause: error,
        });
      }

      throw error;
    }
  }
}

/**
 * Compute how long to wait before retrying a 429.
 *
 * Prefers the server-provided reset timestamp; falls back to capped
 * exponential backoff with a small fixed buffer to avoid retrying a hair too
 * early due to clock skew.
 */
function rateLimitWaitMs(error: ApiResponseError, attempt: number, retry: RetryOptions): number {
  const resetEpochSec = error.rateLimit?.reset;
  if (typeof resetEpochSec === "number") {
    const untilResetMs = resetEpochSec * 1_000 - Date.now();
    // Clamp negatives (already past) to 0; add a 1s buffer for clock skew.
    return Math.max(0, untilResetMs) + 1_000;
  }

  const backoff = retry.baseDelayMs * 2 ** attempt;
  return Math.min(backoff, retry.maxDelayMs);
}
