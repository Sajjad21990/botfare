import type { NextConfig } from "next";

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
