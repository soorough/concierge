import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export type DB = Database.Database;

let db: DB | null = null;

export function getDb(): DB {
  if (db) return db;
  const path = process.env.DB_PATH ?? './data/concierge.db';
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Idempotent. Schema first, then the FTS5 sync triggers. */
export function migrate(target?: DB): DB {
  const d = target ?? getDb();
  d.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  d.exec(readFileSync(join(here, 'triggers.sql'), 'utf8'));
  return d;
}

export function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
