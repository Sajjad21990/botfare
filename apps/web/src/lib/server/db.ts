import { createDb, type Db, type DbHandle } from "@botfare/core";

/** One connection pool per process, kept on globalThis so dev hot reloads do not leak pools. */
const globalForDb = globalThis as typeof globalThis & { __botfareDb?: DbHandle };

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  return url;
}

/** The shared database handle. Connects lazily, on the first query. */
export function getDbHandle(): DbHandle {
  globalForDb.__botfareDb ??= createDb(databaseUrl());
  return globalForDb.__botfareDb;
}

export function getDb(): Db {
  return getDbHandle().db;
}

/** True if Postgres answers a trivial query. */
export async function pingDb(): Promise<boolean> {
  try {
    await getDbHandle().sql`select 1`;
    return true;
  } catch {
    return false;
  }
}

/** Closes the pool (tests and shutdown); the next getDb() opens a new one. */
export async function closeDb(): Promise<void> {
  const handle = globalForDb.__botfareDb;
  globalForDb.__botfareDb = undefined;
  await handle?.close();
}
