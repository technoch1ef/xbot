/**
 * Account Activity API (AAA) webhook helpers.
 *
 * This module is the *pure* core of the optional, feature-flagged webhook
 * receiver (see {@link ../server}). It has no Fastify or I/O dependencies so it
 * can be unit-tested in isolation, and it covers the three security/normalize
 * concerns AAA imposes:
 *
 *  1. **CRC challenge** ({@link buildCrcResponse}) — when X (re)registers the
 *     webhook it issues a GET with a `crc_token`; we must answer with
 *     `sha256=<base64 HMAC-SHA256(crc_token, consumerSecret)>`.
 *  2. **Inbound signature verification** ({@link verifyEventSignature}) — every
 *     POSTed event carries an `x-twitter-webhooks-signature` header of the same
 *     shape, computed over the *raw* request body. We recompute and compare in
 *     constant time so forged events are rejected.
 *  3. **Event normalization** ({@link normalizeMentions}) — AAA delivers v1.1
 *     "tweet_create_events"; we translate the ones that actually mention the
 *     bot into the {@link PipelineMention} shape the shared pipeline consumes.
 *
 * The consumer secret used for both HMACs is the app's API/consumer secret
 * (`X_APP_SECRET`). It is never logged.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { PipelineMention } from "../pipeline/process.js";

/** Header X attaches to every AAA event POST. */
export const SIGNATURE_HEADER = "x-twitter-webhooks-signature";

/** Compute `sha256=<base64 HMAC-SHA256(data, secret)>` — the AAA token shape. */
function sign(data: string | Buffer, consumerSecret: string): string {
  const digest = createHmac("sha256", consumerSecret).update(data).digest("base64");
  return `sha256=${digest}`;
}

/**
 * Build the response token for an AAA CRC (Challenge-Response Check) GET.
 *
 * @param crcToken The `crc_token` query parameter X sent.
 * @param consumerSecret The app's API/consumer secret (`X_APP_SECRET`).
 * @returns The value to return as `{ response_token }`.
 */
export function buildCrcResponse(crcToken: string, consumerSecret: string): string {
  return sign(crcToken, consumerSecret);
}

/**
 * Verify the signature on an inbound AAA event POST.
 *
 * Recomputes the expected signature over the *raw* request body and compares it
 * to the provided header in constant time. A missing/empty header, a
 * length mismatch, or any digest mismatch all yield `false`.
 *
 * @param signatureHeader Value of the `x-twitter-webhooks-signature` header.
 * @param rawBody The exact bytes of the request body (not a re-serialized JSON).
 * @param consumerSecret The app's API/consumer secret (`X_APP_SECRET`).
 */
export function verifyEventSignature(
  signatureHeader: string | undefined,
  rawBody: Buffer,
  consumerSecret: string,
): boolean {
  if (!signatureHeader) return false;

  const expected = Buffer.from(sign(rawBody, consumerSecret));
  const provided = Buffer.from(signatureHeader);

  // timingSafeEqual requires equal-length buffers; an early length check both
  // satisfies that and short-circuits obviously-wrong signatures.
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/* -------------------------------------------------------------------------- */
/* Event normalization                                                        */
/* -------------------------------------------------------------------------- */

/** Minimal v1.1 user object as it appears inside AAA tweet events. */
interface AaaUser {
  id_str?: string;
  screen_name?: string;
}

/** A `@mention` entity inside a v1.1 tweet's `entities`. */
interface AaaUserMention {
  id_str?: string;
}

/** Minimal v1.1 tweet object delivered in `tweet_create_events`. */
interface AaaTweet {
  id_str?: string;
  text?: string;
  full_text?: string;
  lang?: string;
  user?: AaaUser;
  in_reply_to_status_id_str?: string | null;
  retweeted_status?: unknown;
  entities?: { user_mentions?: AaaUserMention[] };
  extended_tweet?: { full_text?: string };
}

/** The subset of the AAA event envelope we consume. */
export interface AaaEventPayload {
  /** ID of the subscribed user the events are delivered for. */
  for_user_id?: string;
  /** New tweets in the subscription (mentions, replies, the user's own, …). */
  tweet_create_events?: AaaTweet[];
}

/** Pick the fullest available text for a (possibly extended) tweet. */
function tweetText(tweet: AaaTweet): string {
  return tweet.extended_tweet?.full_text ?? tweet.full_text ?? tweet.text ?? "";
}

/** True if `tweet`'s mention entities reference `botUserId`. */
function mentionsBot(tweet: AaaTweet, botUserId: string): boolean {
  return (tweet.entities?.user_mentions ?? []).some((m) => m.id_str === botUserId);
}

/**
 * Normalize an AAA event payload into pipeline-ready mentions.
 *
 * Only `tweet_create_events` that actually mention the bot (and are not the
 * bot's own tweets) are emitted; everything else AAA may bundle in the same
 * envelope is ignored here. Downstream the shared filter still applies its own
 * own-tweet/retweet/blocklist/dedupe checks, so this is a coarse first pass.
 *
 * Malformed entries (missing `id_str`) are skipped rather than throwing, so one
 * bad event can never reject an entire valid batch.
 *
 * @param payload The parsed AAA event envelope.
 * @param botUserId The bot's numeric user ID (`BOT_USER_ID`).
 */
export function normalizeMentions(payload: AaaEventPayload, botUserId: string): PipelineMention[] {
  const events = payload.tweet_create_events ?? [];
  const mentions: PipelineMention[] = [];

  for (const tweet of events) {
    const id = tweet.id_str;
    const authorId = tweet.user?.id_str;
    if (!id || !authorId) continue; // malformed — skip defensively.
    if (authorId === botUserId) continue; // never our own tweets.
    if (!mentionsBot(tweet, botUserId)) continue; // only real mentions.

    const mention: PipelineMention = {
      id,
      text: tweetText(tweet),
      authorId,
      isRetweet: tweet.retweeted_status !== undefined,
      ...(tweet.user?.screen_name !== undefined ? { authorUsername: tweet.user.screen_name } : {}),
      ...(tweet.in_reply_to_status_id_str
        ? { inReplyToTweetId: tweet.in_reply_to_status_id_str }
        : {}),
      ...(tweet.lang !== undefined ? { lang: tweet.lang } : {}),
    };

    mentions.push(mention);
  }

  return mentions;
}
