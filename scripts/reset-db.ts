/**
 * Empties a demo database for a fresh start: drops every table (the public schema) and Drizzle's
 * migration record, so `pnpm db:migrate`, `pnpm seed --print-secrets` and `pnpm seed:traffic` start
 * from nothing. Permanent. PayPal's own sandbox records are not touched.
 *
 * Refuses unless `--yes-delete-everything` is passed, and refuses a database on this machine
 * (localhost) unless `--allow-local` is passed too, so the development database is never emptied
 * by accident. Meant for the Render demo database, from botfare-web's Shell (README "Deploy").
 */
import { createDb } from "@botfare/core";
import { loadRootEnv, requireEnv } from "./lib/env-file";
import { describeTarget, refusalFor } from "./lib/reset-guard";

async function main(): Promise<void> {
  loadRootEnv();
  const url = requireEnv("DATABASE_URL");
  const refusal = refusalFor(url, process.argv.slice(2));
  if (refusal) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }
  const handle = createDb(url, { max: 1 });
  try {
    await handle.sql`drop schema if exists drizzle cascade`;
    await handle.sql`drop schema if exists public cascade`;
    await handle.sql`create schema public`;
    console.info(`Emptied ${describeTarget(url)}.`);
    console.info("Next: pnpm db:migrate, then pnpm seed --print-secrets, then pnpm seed:traffic");
  } finally {
    await handle.close();
  }
}

await main();
