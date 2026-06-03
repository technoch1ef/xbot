/**
 * Central, typed configuration validated at startup.
 *
 * The app fails fast on missing/invalid env vars: a single aggregated error
 * lists every problem so operators can fix everything in one pass.
 *
 * No secret values are ever logged or embedded in error messages — only the
 * names of the offending variables and human-readable validation reasons.
 */
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load .env only outside production; in production rely on the real
// environment (e.g. injected secrets) and never read a local .env file.
if (process.env.NODE_ENV !== "production") {
  loadDotenv();
}

/**
 * Coerce common truthy/falsy string spellings into a boolean.
 * Accepts: true/false, 1/0, yes/no, on/off (case-insensitive).
 */
const booleanFromString = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = value.toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `expected a boolean (true/false, 1/0, yes/no, on/off), got "${value}"`,
    });
    return z.NEVER;
  });

const nonEmptyString = z.string().trim().min(1, "must not be empty");

const ConfigSchema = z
  .object({
    // --- X (Twitter) credentials, OAuth 1.0a user context ---
    X_APP_KEY: nonEmptyString,
    X_APP_SECRET: nonEmptyString,
    X_ACCESS_TOKEN: nonEmptyString,
    X_ACCESS_SECRET: nonEmptyString,
    BOT_USER_ID: nonEmptyString,

    // --- OpenAI ---
    OPENAI_API_KEY: nonEmptyString,
    OPENAI_MODEL: z.string().trim().min(1).default("gpt-4o-mini"),
    OPENAI_TEMPERATURE: z.coerce
      .number({ invalid_type_error: "must be a number" })
      .min(0, "must be >= 0")
      .max(2, "must be <= 2")
      .default(0.7),

    // --- Bot behavior ---
    POLL_INTERVAL_SEC: z.coerce
      .number({ invalid_type_error: "must be a number" })
      .int("must be an integer")
      .positive("must be > 0")
      .default(300),
    MAX_REPLIES_PER_RUN: z.coerce
      .number({ invalid_type_error: "must be a number" })
      .int("must be an integer")
      .positive("must be > 0")
      .default(5),
    DRY_RUN: booleanFromString.default("false"),

    // --- HTTP server (health + optional webhook receiver) ---
    PORT: z.coerce
      .number({ invalid_type_error: "must be a number" })
      .int("must be an integer")
      .min(0, "must be >= 0")
      .max(65535, "must be <= 65535")
      .default(3000),
    HOST: z.string().trim().min(1).default("0.0.0.0"),

    // --- Optional Account Activity API (AAA) webhook receiver ---
    // Off by default; AAA access is Enterprise-only. When enabled, a Fastify
    // route handles the CRC challenge and verified push events, reusing the
    // same reply pipeline as the poller.
    WEBHOOK_ENABLED: booleanFromString.default("false"),
    // Path the webhook routes are mounted at (GET = CRC, POST = events).
    WEBHOOK_PATH: z
      .string()
      .trim()
      .min(1)
      .regex(/^\//, "must start with '/'")
      .default("/webhook/twitter"),

    // --- Inbound mention filtering (all optional) ---
    // Comma-separated user IDs and/or @handles to never reply to.
    BLOCKLIST: z.string().trim().optional(),
    // Comma-separated BCP-47 language codes to allow. When unset, all
    // languages are allowed; when set, mentions in other languages are skipped.
    ALLOWED_LANGUAGES: z.string().trim().optional(),

    // --- Persona (inline prompt OR a path to a prompt file) ---
    PERSONA_PROMPT: z.string().trim().min(1).optional(),
    PERSONA_PROMPT_PATH: z.string().trim().min(1).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.PERSONA_PROMPT && !cfg.PERSONA_PROMPT_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PERSONA_PROMPT"],
        message: "either PERSONA_PROMPT or PERSONA_PROMPT_PATH must be provided",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse and validate the given environment (defaults to process.env).
 *
 * @throws Error with an aggregated, secret-free message listing every
 *         missing or invalid variable when validation fails.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (result.success) {
    return result.data;
  }

  const problems = result.error.issues
    .map((issue) => {
      const name = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${name}: ${issue.message}`;
    })
    .sort();

  throw new Error(
    `Invalid configuration — fix the following environment variable(s):\n${problems.join("\n")}`,
  );
}

/**
 * The validated, typed config object. Importing this module validates the
 * environment immediately, so the process fails fast on misconfiguration.
 */
export const config: Config = loadConfig();
