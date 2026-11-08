// Shared setup for the spike scripts: load .env, validate the vars, build a sandbox client,
// and print PASS / FAIL lines.
import { resolve } from "node:path";
import {
  type CaptureOrderResult,
  createPayPalClient,
  PayPalApiError,
  type PayPalClient,
} from "@botfare/paypal";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname, "../..");

const envSchema = z.object({
  PAYPAL_CLIENT_ID: z.string().trim().min(1),
  PAYPAL_CLIENT_SECRET: z.string().trim().min(1),
  PUBLISHER_PAYPAL_EMAIL: z.email(),
});

export type SpikeEnv = z.infer<typeof envSchema>;
export type SpikeEnvKey = keyof SpikeEnv;

let envFileLoaded = false;

function loadEnvFile(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  try {
    process.loadEnvFile(resolve(ROOT, ".env"));
  } catch (error) {
    // No .env is fine: the vars may come from the shell. Anything else is worth a warning.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`Warning: could not read .env: ${(error as Error).message}`);
    }
  }
}

/**
 * Loads `.env` from the repo root (if present) and returns the requested vars.
 * Exits with a friendly message naming every missing or invalid var.
 */
export function loadEnv<K extends SpikeEnvKey>(...keys: K[]): Pick<SpikeEnv, K> {
  loadEnvFile();
  const values: Partial<SpikeEnv> = {};
  const problems: string[] = [];
  for (const key of keys) {
    const raw = process.env[key];
    const result = envSchema.shape[key].safeParse(raw);
    if (result.success) {
      values[key] = result.data;
    } else {
      problems.push(raw?.trim() ? `${key} (invalid: ${result.error.issues[0]?.message})` : key);
    }
  }
  if (problems.length > 0) {
    console.error("FAIL missing or invalid environment variables:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      `\nCopy .env.example to .env in the repo root (${ROOT}) and fill these in.` +
        "\nThe sandbox credentials are at developer.paypal.com > Apps & Credentials > Sandbox.",
    );
    process.exit(1);
  }
  return values as Pick<SpikeEnv, K>;
}

/** A sandbox client built from PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET. */
export function paypalFromEnv(): PayPalClient {
  const env = loadEnv("PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET");
  return createPayPalClient({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    logger: ({ method, path, status, debugId, ms }) =>
      console.log(`  ${method} ${path} -> ${status} (${ms} ms, debug ${debugId ?? "-"})`),
  });
}

export function pass(message: string): void {
  console.log(`\nPASS ${message}`);
}

/** Prints FAIL plus PayPal's error name, message, debugId and details, then exits non-zero. */
export function fail(message: string, error?: unknown, hints: string[] = []): never {
  console.error(`\nFAIL ${message}`);
  if (error instanceof PayPalApiError) {
    console.error(`  status:  ${error.status}`);
    console.error(`  name:    ${error.name}`);
    console.error(`  message: ${error.message}`);
    console.error(`  debugId: ${error.debugId ?? "-"}`);
    if (error.details.length > 0) {
      console.error(`  details: ${JSON.stringify(error.details, null, 2)}`);
    }
  } else if (error !== undefined) {
    console.error(
      `  ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  }
  for (const hint of hints) console.error(`\nHint: ${hint}`);
  process.exit(1);
}

export function printCapture(capture: CaptureOrderResult): void {
  console.log(`  order ID:       ${capture.orderId} (${capture.status})`);
  console.log(`  capture ID:     ${capture.captureId} (${capture.captureStatus})`);
  console.log(`  gross:          ${capture.gross} ${capture.currency}`);
  console.log(`  PayPal fee:     ${capture.fee ?? "(not yet known: capture pending)"}`);
  console.log(`  net:            ${capture.net ?? "(not yet known: capture pending)"}`);
  console.log(`  payer:          ${capture.payerEmail ?? "-"} (${capture.payerId ?? "-"})`);
}
