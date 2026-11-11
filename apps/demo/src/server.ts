/**
 * Entry point: `pnpm --filter @botfare/demo start` (or `dev`). Reads its settings from the
 * environment; see `demoOptionsFromEnv` in app.ts for the variables.
 */
import { demoOptionsFromEnv, startDemo } from "./app";
import { SITE_NAME } from "./pricing";

const demo = await startDemo(demoOptionsFromEnv());
console.log(`[demo] ${SITE_NAME} listening on ${demo.url}`);
