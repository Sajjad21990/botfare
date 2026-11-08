/**
 * Entry point: `pnpm --filter @botfare/demo start` (or `dev`). Reads its settings from the
 * environment; see `demoOptionsFromEnv` in app.ts for the variables.
 */
import { demoOptionsFromEnv, startDemo } from "./app";

const demo = await startDemo(demoOptionsFromEnv());
console.log(`[demo] Crema Notes listening on ${demo.url}`);
