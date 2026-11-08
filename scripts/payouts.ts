/**
 * `pnpm payouts:run`: the daily payout job (a Render cron runs it once a day).
 *
 * 1. runDailyPayouts: one PayPal Payouts batch with an item for every publisher whose earnings
 *    reach $1.00 and who has a payout email;
 * 2. syncPendingPayouts: refreshes every open payout from PayPal and resubmits batches PayPal
 *    never confirmed (same sender_batch_id, so PayPal dedupes them).
 *
 * Safe to run again: earnings already paid out are gone from the ledger, and every batch is
 * idempotent. Prints a summary; secrets are never printed. Exits non-zero if a step failed.
 */
import {
  createDb,
  DEFAULT_PAYOUT_MINIMUM_CENTS,
  runDailyPayouts,
  syncPendingPayouts,
} from "@botfare/core";
import { createPayPalClient } from "@botfare/paypal";
import { loadRootEnv, requireEnv } from "./lib/env-file";

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function main(): Promise<void> {
  loadRootEnv();
  const handle = createDb(requireEnv("DATABASE_URL"));
  const paypal = createPayPalClient({
    clientId: requireEnv("PAYPAL_CLIENT_ID"),
    clientSecret: requireEnv("PAYPAL_CLIENT_SECRET"),
    logger: (e) => console.info(`  [paypal] ${e.method} ${e.path} -> ${e.status} (${e.ms} ms)`),
  });
  let failed = false;
  try {
    console.info(`Daily payouts (minimum ${usd(DEFAULT_PAYOUT_MINIMUM_CENTS)})`);
    const run = await runDailyPayouts(handle.db, paypal);
    if (!run.batchKey) {
      console.info("  No publisher is due a payout.");
    } else {
      const total = run.payouts.reduce((sum, payout) => sum + payout.amountCents, 0);
      console.info(`  Batch ${run.batchKey}: ${run.payouts.length} payout(s), ${usd(total)}`);
      for (const payout of run.payouts) {
        console.info(
          `    ${payout.id}  ${usd(payout.amountCents).padStart(9)}  ${payout.status}` +
            (payout.error ? `  (${payout.error})` : ""),
        );
      }
    }
    if (run.skippedNoEmail.length > 0) {
      console.info(
        `  Skipped ${run.skippedNoEmail.length} publisher(s) with no payout email: ` +
          run.skippedNoEmail.join(", "),
      );
    }

    console.info("Syncing open payouts with PayPal");
    const sync = await syncPendingPayouts(handle.db, paypal);
    console.info(`  ${sync.batches} open batch(es) checked`);
    for (const error of sync.errors) {
      failed = true;
      console.error(`  FAIL ${error.batchKey}: ${error.error}`);
    }
  } catch (err) {
    failed = true;
    console.error(`FAIL ${(err as Error).message}`);
  } finally {
    await handle.close();
  }
  if (failed) process.exitCode = 1;
  else console.info("Done.");
}

await main();
