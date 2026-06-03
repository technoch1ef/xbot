/**
 * SQLite-backed persistence for idempotency.
 *
 * Tracks two things so the bot survives restarts/crashes:
 *  1. The `since_id` cursor for mentions pagination.
 *  2. The set of source tweet IDs already replied to (reply dedupe).
 *
 * Single-writer assumption: exactly one worker process touches this DB.
 * Schema is created/migrated on boot. All queries use prepared statements
 * with bound parameters — no string interpolation, so no SQL injection.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

/** Key used for the single-row cursor in the key/value `meta` table. */
const CURSOR_KEY = "since_id";

export interface Store {
  /** Return the stored mentions cursor, or undefined if none set yet. */
  getCursor(): string | undefined;
  /** Persist the mentions cursor (since_id). */
  setCursor(sinceId: string): void;
  /** True if we've already replied to the given source tweet. */
  hasReplied(tweetId: string): boolean;
  /** Record that we've replied to the given source tweet (idempotent). */
  markReplied(tweetId: string): void;
  /** Close the underlying database handle. */
  close(): void;
}

/**
 * Open (creating if absent) the SQLite store at `dbPath` and run migrations.
 *
 * @param dbPath Filesystem path to the SQLite database file. Parent
 *   directories are created if they do not exist. Defaults to the
 *   `DATABASE_PATH` env var, falling back to `./xbot.db`.
 */
export function openStore(dbPath: string = process.env.DATABASE_PATH ?? "./xbot.db"): Store {
  // Ensure the parent directory exists for file-based databases.
  // ":memory:" and other special handles have no directory to create.
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  migrate(db);

  const selectCursor = db.prepare<[string]>("SELECT value FROM meta WHERE key = ?");
  const upsertCursor = db.prepare<[string, string]>(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const selectReplied = db.prepare<[string]>("SELECT 1 FROM replied_tweets WHERE tweet_id = ?");
  const insertReplied = db.prepare<[string]>(
    `INSERT INTO replied_tweets (tweet_id, replied_at) VALUES (?, unixepoch())
     ON CONFLICT(tweet_id) DO NOTHING`,
  );

  return {
    getCursor(): string | undefined {
      const row = selectCursor.get(CURSOR_KEY) as { value: string } | undefined;
      return row?.value;
    },
    setCursor(sinceId: string): void {
      upsertCursor.run(CURSOR_KEY, sinceId);
    },
    hasReplied(tweetId: string): boolean {
      return selectReplied.get(tweetId) !== undefined;
    },
    markReplied(tweetId: string): void {
      insertReplied.run(tweetId);
    },
    close(): void {
      db.close();
    },
  };
}

/** Create tables if they don't already exist. Idempotent. */
function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replied_tweets (
      tweet_id   TEXT PRIMARY KEY,
      replied_at INTEGER NOT NULL
    );
  `);
}
