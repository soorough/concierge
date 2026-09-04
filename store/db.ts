import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export type DB = Database.Database;

let db: DB | null = null;

const DEFAULT_DB_PATH = './data/concierge.db';

export function dbPath(): string {
  return resolve(process.env.DB_PATH ?? DEFAULT_DB_PATH);
}

export type StorageCheck = {
  path: string;
  persistent: boolean;
  reason: string;
};

/**
 * Whether the database sits on a real mounted volume.
 *
 * Checking that the path merely looks right is not enough, and this was learned the hard
 * way: DB_PATH was an absolute /data/concierge.db, the check reported persistent, three
 * brands were ingested — and the next deploy took them. If no volume is mounted there, the
 * process simply creates /data as an ordinary directory inside the container, which is
 * indistinguishable by path alone.
 *
 * A mount has its own device. Comparing the device id of the database's directory against
 * the root filesystem answers the real question rather than the cosmetic one.
 */
export function checkStorage(): StorageCheck {
  const configured = process.env.DB_PATH;
  const path = dbPath();

  if (!configured) {
    return { path, persistent: false, reason: 'DB_PATH is unset, so the database is inside the container' };
  }
  if (!isAbsolute(configured)) {
    return {
      path,
      persistent: false,
      reason: `DB_PATH "${configured}" is relative, so it resolves inside the working directory and is erased on the next deploy`,
    };
  }

  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const onVolume = statSync(dir).dev !== statSync('/').dev;
    return onVolume
      ? { path, persistent: true, reason: 'on a mounted volume' }
      : {
          path,
          persistent: false,
          reason: `${dir} is on the same device as the container filesystem — no volume is mounted there, so a deploy erases it`,
        };
  } catch (e) {
    return { path, persistent: false, reason: `could not stat the database directory: ${(e as Error).message}` };
  }
}

export function storageIsPersistent(): boolean {
  return checkStorage().persistent;
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
