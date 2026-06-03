/**
 * HTTP server: always-on health check plus the optional, feature-flagged
 * Account Activity API (AAA) webhook receiver.
 *
 * The server is intentionally thin. `/health` is always available for liveness
 * probes. The webhook routes are mounted *only* when `WEBHOOK_ENABLED=true`, so
 * by default this is just a health endpoint and the poller (bd-120.9) is the
 * sole ingestion path. When enabled, the webhook routes reuse the exact same
 * reply pipeline as the poller — AAA can be turned on later without touching
 * any core logic.
 *
 * Security model for the webhook routes (all enforced in {@link ../x/webhook}):
 *  - **GET** answers X's CRC challenge by HMAC-signing the `crc_token`.
 *  - **POST** verifies the `x-twitter-webhooks-signature` header over the *raw*
 *    request body before doing anything with the payload; unsigned or forged
 *    events get a 403 and never reach the pipeline.
 *
 * Inbound events are normalized and handed to the pipeline *asynchronously*: we
 * acknowledge with 200 immediately (X expects a fast response and retries on
 * timeout) and process in the background, logging any failure.
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";

import { processMentions, type PipelineDeps } from "./pipeline/process.js";
import {
  SIGNATURE_HEADER,
  buildCrcResponse,
  normalizeMentions,
  verifyEventSignature,
  type AaaEventPayload,
} from "./x/webhook.js";

// Capture the raw request body so webhook signatures can be verified over the
// exact bytes X signed (a re-serialized JSON object would not match).
declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/** Configuration for the optional AAA webhook routes. */
export interface WebhookOptions {
  /** When false, only `/health` is mounted. */
  enabled: boolean;
  /** Path the GET (CRC) and POST (events) routes are mounted at. */
  path: string;
  /** App API/consumer secret (`X_APP_SECRET`) used for HMAC signing. */
  consumerSecret: string;
  /** The bot's numeric user ID (`BOT_USER_ID`), for mention normalization. */
  botUserId: string;
}

/** Collaborators and configuration for the HTTP server. */
export interface ServerDeps {
  /** Shared reply pipeline (same instance the poller uses). */
  pipeline: PipelineDeps;
  /** Webhook feature configuration. */
  webhook: WebhookOptions;
  /** Structured logger for server-level events. */
  logger: Logger;
}

/** Shape of the CRC challenge query string. */
interface CrcQuery {
  crc_token?: string;
}

/** Read a possibly-array header down to a single string value. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Build (but do not start) the Fastify server.
 *
 * The caller is responsible for `listen()` and graceful `close()` (wired by the
 * entrypoint in bd-120.11). Fastify's own logger is disabled in favor of the
 * provided pino logger.
 *
 * @param deps Pipeline, webhook config, and logger.
 * @returns A configured {@link FastifyInstance}.
 */
export function createServer(deps: ServerDeps): FastifyInstance {
  const { pipeline, webhook, logger } = deps;
  const app = Fastify({ logger: false });

  // Liveness probe — always available, regardless of the webhook flag.
  app.get("/health", async () => ({ status: "ok" }));

  if (!webhook.enabled) {
    logger.info({ stage: "server" }, "webhook receiver disabled; only /health mounted");
    return app;
  }

  // Preserve the raw body for signature verification while still exposing the
  // parsed JSON to handlers.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const buffer = body as Buffer;
    request.rawBody = buffer;
    if (buffer.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(buffer.toString("utf8")));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // CRC challenge: X issues this on (re)registration and periodically.
  app.get<{ Querystring: CrcQuery }>(webhook.path, async (request, reply) => {
    const crcToken = request.query.crc_token;
    if (!crcToken) {
      logger.warn({ stage: "webhook" }, "CRC request missing crc_token");
      return reply.code(400).send({ error: "missing crc_token" });
    }
    logger.info({ stage: "webhook" }, "answered CRC challenge");
    return reply.code(200).send({
      response_token: buildCrcResponse(crcToken, webhook.consumerSecret),
    });
  });

  // Inbound activity events.
  app.post(webhook.path, async (request, reply) => {
    const signature = headerValue(request.headers[SIGNATURE_HEADER]);
    const rawBody = request.rawBody ?? Buffer.alloc(0);

    if (!verifyEventSignature(signature, rawBody, webhook.consumerSecret)) {
      logger.warn({ stage: "webhook" }, "rejected event with invalid signature");
      return reply.code(403).send({ error: "invalid signature" });
    }

    const payload = request.body as AaaEventPayload;
    const mentions = normalizeMentions(payload, webhook.botUserId);

    logger.info(
      { stage: "webhook", forUser: payload.for_user_id, mentions: mentions.length },
      "verified event accepted",
    );

    // Acknowledge immediately; process out of band so a slow pipeline can't
    // cause X to time out and retry. Failures are logged, never thrown.
    if (mentions.length > 0) {
      void processMentions(mentions, pipeline).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ stage: "webhook", err }, `event processing failed: ${message}`);
      });
    }

    return reply.code(200).send({ status: "accepted" });
  });

  logger.info({ stage: "server", path: webhook.path }, "webhook receiver enabled (CRC + events)");
  return app;
}
