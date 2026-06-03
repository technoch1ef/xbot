/**
 * Crypto-themed reply generation via the OpenAI Chat Completions API.
 *
 * Given an incoming mention (plus limited thread context), this builds a
 * message list anchored by a configurable persona system prompt and asks the
 * model for a single on-brand reply. The output is constrained to X's 280-char
 * limit both by instruction and by a hard truncation fallback, so a chatty
 * model can never produce a tweet the API would reject.
 *
 * Safety note: this layer only shapes tone/length. Content safety (moderation
 * + financial-advice disclaimer) is enforced separately downstream (bd-120.6).
 */
import { readFileSync } from "node:fs";

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { Config } from "../config.js";

/** X's hard limit on tweet length, in characters. */
export const MAX_TWEET_CHARS = 280;

/** Default persona file, used when no inline/path persona is configured. */
export const DEFAULT_PERSONA_PATH = "prompts/persona.md";

/** Token accounting for a single generation, surfaced for logging/metrics. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** The mention (and minimal thread context) a reply is generated for. */
export interface ReplyContext {
  /** Text of the incoming mention. */
  tweetText: string;
  /** Author handle (without `@`), used to personalize context. */
  authorUsername?: string;
  /** Text of the tweet this mention replied to, if any (limited context). */
  inReplyToText?: string;
}

/** A generated reply plus the token usage it consumed. */
export interface GeneratedReply {
  /** Reply text, guaranteed to be <= {@link MAX_TWEET_CHARS} characters. */
  text: string;
  /** Whether the model output was hard-truncated to fit the char limit. */
  truncated: boolean;
  /** Token usage for the underlying completion (zeroed if unreported). */
  usage: TokenUsage;
}

/** Generates crypto-themed replies from incoming mentions. */
export interface ReplyGenerator {
  /**
   * Generate a single reply for the given mention context.
   *
   * @param context Incoming mention text and optional thread context.
   * @returns The generated (length-constrained) reply and token usage.
   * @throws Error if the model returns no usable text.
   */
  generate(context: ReplyContext): Promise<GeneratedReply>;
}

/**
 * Resolve the persona system prompt from config, in priority order:
 *  1. `PERSONA_PROMPT` (inline string)
 *  2. `PERSONA_PROMPT_PATH` (file on disk)
 *  3. {@link DEFAULT_PERSONA_PATH} bundled default
 *
 * @throws Error if a configured path cannot be read.
 */
export function loadPersona(config: Config): string {
  if (config.PERSONA_PROMPT) {
    return config.PERSONA_PROMPT;
  }

  const path = config.PERSONA_PROMPT_PATH ?? DEFAULT_PERSONA_PATH;
  try {
    return readFileSync(path, "utf8").trim();
  } catch (cause) {
    throw new Error(`Failed to read persona prompt from "${path}"`, { cause });
  }
}

/**
 * Build the chat message list: persona system prompt followed by a user
 * message describing the mention and any limited thread context.
 */
export function buildMessages(
  persona: string,
  context: ReplyContext,
): ChatCompletionMessageParam[] {
  const parts: string[] = [];

  if (context.inReplyToText) {
    parts.push(`In reply to an earlier tweet:\n"""${context.inReplyToText}"""`);
  }

  const who = context.authorUsername ? `@${context.authorUsername}` : "Someone";
  parts.push(`${who} mentioned you with:\n"""${context.tweetText}"""`);
  parts.push(`Write a single reply tweet (max ${MAX_TWEET_CHARS} characters). Plain text only.`);

  return [
    { role: "system", content: persona },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/**
 * Hard-truncate `text` to at most {@link MAX_TWEET_CHARS} characters, breaking
 * on a word boundary where possible and appending a single-character ellipsis.
 *
 * @returns The (possibly shortened) text and whether truncation occurred.
 */
export function enforceLength(text: string): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TWEET_CHARS) {
    return { text: trimmed, truncated: false };
  }

  // Reserve one char for the ellipsis, then prefer the last whitespace break.
  const budget = MAX_TWEET_CHARS - 1;
  const slice = trimmed.slice(0, budget);
  const lastSpace = slice.lastIndexOf(" ");
  // Only honor the word boundary if it doesn't discard too much text.
  const cut = lastSpace > budget * 0.6 ? slice.slice(0, lastSpace) : slice;
  return { text: `${cut.trimEnd()}\u2026`, truncated: true };
}

/**
 * Create a {@link ReplyGenerator} backed by the OpenAI Chat Completions API.
 *
 * Model and temperature come from `config`; the persona is resolved once at
 * construction via {@link loadPersona}.
 *
 * @param config Validated app configuration.
 * @param deps Optional injection seams (preconstructed client, persona override).
 */
export function createReplyGenerator(
  config: Config,
  deps: { client?: OpenAI; persona?: string } = {},
): ReplyGenerator {
  const client = deps.client ?? new OpenAI({ apiKey: config.OPENAI_API_KEY });
  const persona = deps.persona ?? loadPersona(config);

  return {
    async generate(context: ReplyContext): Promise<GeneratedReply> {
      const completion = await client.chat.completions.create({
        model: config.OPENAI_MODEL,
        temperature: config.OPENAI_TEMPERATURE,
        messages: buildMessages(persona, context),
      });

      const raw = completion.choices[0]?.message?.content?.trim();
      if (!raw) {
        throw new Error("OpenAI returned an empty reply");
      }

      const { text, truncated } = enforceLength(raw);

      return {
        text,
        truncated,
        usage: {
          promptTokens: completion.usage?.prompt_tokens ?? 0,
          completionTokens: completion.usage?.completion_tokens ?? 0,
          totalTokens: completion.usage?.total_tokens ?? 0,
        },
      };
    },
  };
}
