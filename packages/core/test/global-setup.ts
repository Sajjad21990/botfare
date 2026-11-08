import postgres from "postgres";
import { migrate } from "../src/migrate";
import { testDatabaseUrl } from "./db-url";

/** Wipes the test database and applies every migration, once per vitest run. */
export default async function setup() {
  const url = testDatabaseUrl();
  if (!new URL(url).pathname.endsWith("_test")) {
    throw new Error(`Refusing to reset ${new URL(url).pathname}: not a *_test database`);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe("drop schema if exists drizzle cascade");
    await sql.unsafe("drop schema if exists public cascade");
    await sql.unsafe("create schema public");
  } finally {
    await sql.end({ timeout: 5 });
  }
  await migrate(url);
}
