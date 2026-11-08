import { configDefaults, defineConfig } from "vitest/config";

/**
 * Tests named `*.db.test.ts` use Postgres (TEST_DATABASE_URL, the botfare_test database). They run
 * as their own project: the schema is reset and migrated once per run, and files run one at a time.
 */
const dbTests = ["packages/*/test/**/*.db.test.ts", "apps/*/test/**/*.db.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...dbTests],
        },
      },
      {
        test: {
          name: "db",
          include: dbTests,
          globalSetup: ["packages/core/test/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 20_000,
        },
      },
    ],
  },
});
