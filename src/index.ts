/**
 * xbot — crypto-themed X.com auto-reply bot.
 *
 * Application entrypoint. This module is the single composition root: it builds
 * every collaborator exactly once, wires them into the reply pipeline, starts
 * the polling worker, optionally starts the Account Activity API webhook
 * receiver, and installs signal handlers for a clean, drain-on-shutdown stop.
 *
 * Lifecycle:
 *   load config → init store → build pipeline → start poller
 *                                            → (optional) start HTTP server
 *
 * Shutdown (SIGINT / SIGTERM): stop the poller (awaiting any in-flight tick),
 * close the HTTP server if running, then close the database handle. The first
 * signal triggers a graceful drain; a second forces an immediate exit.
 */
import pino, { type Logger } from "pino";

import { createReplyGenerator } from "./ai/generate.js";
import { config } from "./config.js";
import { buildFilterOptions } from "./pipeline/filter.js";
import type { PipelineDeps } from "./pipeline/process.js";
import { createSafetyGuard } from "./pipeline/safety.js";
import { createServer } from "./server.js";
import { openStore } from "./store/db.js";
import { createXClient } from "./x/client.js";
import { createPoller } from "./x/poller.js";

/** Process exit codes used on fatal startup/shutdown failures. */
const EXIT_STARTUP_FAILURE = 1;

/**
 * Build the single shared pino logger. Pretty-printing is intentionally left to
 * the operator (e.g. piping through `pino-pretty` in dev) so production logs
 * stay as structured NDJSON.
 */
function createLogger(): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service: "xbot" },
  });
}

async function main(): Promise<void> {
  const logger = createLogger();

  logger.info(
    {
      stage: "boot",
      dryRun: config.DRY_RUN,
      webhookEnabled: config.WEBHOOK_ENABLED,
      pollIntervalSec: config.POLL_INTERVAL_SEC,
      maxRepliesPerRun: config.MAX_REPLIES_PER_RUN,
    },
    "xbot starting up",
  );

  // --- Collaborators (built once) ---
  const store = openStore();
  const client = createXClient(config);
  const generator = createReplyGenerator(config);
  const safety = createSafetyGuard(config);

  const pipeline: PipelineDeps = {
    filterOptions: buildFilterOptions(config),
    generator,
    safety,
    client,
    store,
    logger,
    config: {
      dryRun: config.DRY_RUN,
      maxRepliesPerRun: config.MAX_REPLIES_PER_RUN,
    },
  };

  // --- Poller (primary ingestion path) ---
  const poller = createPoller({
    pipeline,
    config: { pollIntervalSec: config.POLL_INTERVAL_SEC },
  });

  // Tracks whether the poller is running, surfaced via the HTTP /health probe.
  let pollerRunning = false;

  // --- Optional webhook receiver (Account Activity API) ---
  // Per the AC, the Fastify server (health + webhook routes) only starts when
  // WEBHOOK_ENABLED=true; otherwise the poller is the sole ingestion path.
  const server = config.WEBHOOK_ENABLED
    ? createServer({
        pipeline,
        webhook: {
          enabled: config.WEBHOOK_ENABLED,
          path: config.WEBHOOK_PATH,
          consumerSecret: config.X_APP_SECRET,
          botUserId: config.BOT_USER_ID,
        },
        logger,
        livenessProbe: () => pollerRunning,
      })
    : undefined;

  // --- Graceful shutdown wiring ---
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ stage: "shutdown", signal }, "second signal received; forcing exit");
      process.exit(EXIT_STARTUP_FAILURE);
    }
    shuttingDown = true;
    logger.info({ stage: "shutdown", signal }, "graceful shutdown started");

    try {
      await poller.stop();
      pollerRunning = false;

      if (server) {
        await server.close();
        logger.info({ stage: "shutdown" }, "HTTP server closed");
      }

      store.close();
      logger.info({ stage: "shutdown" }, "store closed; shutdown complete");
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ stage: "shutdown", err }, `error during shutdown: ${message}`);
      process.exit(EXIT_STARTUP_FAILURE);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  // --- Start everything ---
  if (server) {
    await server.listen({ host: config.HOST, port: config.PORT });
    logger.info({ stage: "boot", host: config.HOST, port: config.PORT }, "HTTP server listening");
  }

  poller.start();
  pollerRunning = true;

  logger.info({ stage: "boot" }, "xbot is running");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // The logger may not exist yet if config import threw; fall back to console.
  console.error(`xbot failed to start: ${message}`);
  process.exit(EXIT_STARTUP_FAILURE);
});
