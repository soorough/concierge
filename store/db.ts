import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export type DB = Database.Database;

let db: DB | null = null;

const DEFAULT_DB_PATH = './data/concierge.db';

export function dbPath(): string {
  return resolve(process.env.DB_PATH ?? DEFAULT_DB_PATH);
}

/**
 * Whether the database is somewhere a deploy will not erase.
 *
 * A relative DB_PATH puts the file inside the container image, which looks completely
 * healthy and loses every brand and every conversation on the next deploy — the volume can
 * be mounted correctly and still be unused. This turns that into something visible rather
 * than something discovered later by noticing data missing.
 */
export function storageIsPersistent(): boolean {
  const configured = process.env.DB_PATH;
  if (!configured) return false;
  return isAbsolute(configured) && !resolve(configured).startsWith(resolve(process.cwd()));
}

export function getDb(): DB {
  if (db) return db;
  const path = dbPath();
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
