import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The repo keeps one .env at the root; Next only reads apps/web/.env*. Variables already set in
// the environment (e.g. on Render) win over the file.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    "@botfare/core",
    "@botfare/contracts",
    "@botfare/x402-paypal",
    "@botfare/paypal",
  ],
  serverExternalPackages: ["postgres"],
  turbopack: {
    // @botfare/core's migrate() points at its drizzle folder with `new URL("../drizzle",
    // import.meta.url)`, which Turbopack tries to bundle as an asset and cannot (it is a
    // directory). The web app never runs migrations (use `pnpm db:migrate`), so stub it out.
    resolveAlias: { "../drizzle": "./src/lib/server/no-migrations.ts" },
  },
};

export default nextConfig;
