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
};

export default nextConfig;
