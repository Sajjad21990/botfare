import { defineConfig } from "drizzle-kit";

/** `pnpm --filter @botfare/core db:generate` writes SQL migrations into ./drizzle. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://botfare:botfare@localhost:5432/botfare",
  },
});
