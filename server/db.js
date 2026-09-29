// SQLite storage via Node's built-in driver. One file in DATA_DIR, created on first run.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { C } from "./config.js";

export function openDb(file = path.join(C.dataDir, "whale-sonar.db")){
  if (file !== ":memory:"){
    fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  }
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass TEXT NOT NULL,
      created INTEGER NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      newsletter INTEGER NOT NULL DEFAULT 0,
      newsletter_consent_at INTEGER,
      terms_version TEXT NOT NULL,
      privacy_version TEXT NOT NULL,
      unsub TEXT NOT NULL UNIQUE,
      fails INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      last_issue TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions(
      hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens(
      hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS issues(
      day TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      data TEXT NOT NULL,
      created INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS ask_usage(
      day TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, user_id)
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
  `);
  if (file !== ":memory:"){ try { fs.chmodSync(file, 0o600); } catch {} }
  return db;
}

// Drop expired sessions and tokens, and accounts that never confirmed their email within 7 days.
export function sweep(db, now = Date.now()){
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(now);
  db.prepare("DELETE FROM tokens WHERE expires < ?").run(now);
  db.prepare("DELETE FROM users WHERE verified = 0 AND created < ?").run(now - 7*864e5);
  db.prepare("DELETE FROM ask_usage WHERE day < ?").run(new Date(now - 7*864e5).toISOString().slice(0, 10));
}
