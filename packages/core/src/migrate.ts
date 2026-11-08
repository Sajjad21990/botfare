import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./db";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Applies the SQL migrations in packages/core/drizzle to the database at `url`. */
export async function migrate(
  url: string,
  options: { migrationsFolder?: string } = {},
): Promise<void> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await runMigrations(db, { migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER });
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
