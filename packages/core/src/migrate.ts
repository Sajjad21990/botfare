import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./db";

/**
 * packages/core/drizzle. Built with node:path rather than `new URL("../drizzle", import.meta.url)`,
 * which bundlers such as Turbopack treat as an asset import and fail on (it is a directory).
 */
export function migrationsFolder(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
}

/** Applies the SQL migrations in packages/core/drizzle to the database at `url`. */
export async function migrate(
  url: string,
  options: { migrationsFolder?: string } = {},
): Promise<void> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await runMigrations(db, { migrationsFolder: options.migrationsFolder ?? migrationsFolder() });
  } finally {
    await close();
  }
}

// `pnpm --filter @botfare/core db:migrate` runs this file directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  migrate(url).then(
    () => console.log("Migrations applied"),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
