// Spike 03: pay a publisher $0.25 through a PayPal Payouts batch and wait for it to settle.
import { setTimeout as sleep } from "node:timers/promises";
import { type PayoutBatch, PayPalApiError } from "@botfare/paypal";
import { fail, loadEnv, pass, paypalFromEnv } from "./_env";

const POLL_EVERY_MS = 3_000;
const POLL_FOR_MS = 2 * 60 * 1000;
const PAYOUTS_HINT =
  "Payouts may be off for this sandbox app: developer.paypal.com > Apps & Credentials > " +
  "your app > Features > tick Payouts; the app must belong to a US business sandbox account.";

// Validate all three up front so a fresh checkout sees every missing var at once.
const { PUBLISHER_PAYPAL_EMAIL } = loadEnv(
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PUBLISHER_PAYPAL_EMAIL",
);
const paypal = paypalFromEnv();

function hintsFor(error: unknown): string[] {
  return error instanceof PayPalApiError && error.name === "AUTHORIZATION_ERROR"
    ? [PAYOUTS_HINT]
    : [];
}

function printBatch(batch: PayoutBatch): void {
  console.log(`  batch ID:     ${batch.batchId}`);
  console.log(`  batch status: ${batch.batchStatus}`);
  for (const item of batch.items) {
    const error = item.errors ? ` [${item.errors.name}: ${item.errors.message}]` : "";
    console.log(
      `  item ${item.payoutItemId}: ${item.transactionStatus} ` +
        `${item.amount} ${item.currency} -> ${item.receiver ?? "?"}${error}`,
    );
  }
}

const stamp = Date.now();
let batchId: string;
try {
  console.log(`Sending $0.25 USD to ${PUBLISHER_PAYPAL_EMAIL}...`);
  const created = await paypal.createPayoutBatch({
    senderBatchId: `spike_${stamp}`,
    emailSubject: "BotFare spike payout",
    emailMessage: "Test payout from the BotFare sandbox spike.",
    items: [
      {
        receiver: PUBLISHER_PAYPAL_EMAIL,
        amount: "0.25",
        currency: "USD",
        note: "BotFare spike: publisher earnings test",
        senderItemId: `spike_item_${stamp}`,
      },
    ],
  });
  batchId = created.batchId;
  console.log(`  batch ID: ${created.batchId} (${created.batchStatus})`);
} catch (error) {
  fail("could not create the payout batch", error, hintsFor(error));
}

let batch: PayoutBatch | undefined;
const deadline = Date.now() + POLL_FOR_MS;
try {
  console.log(
    `Polling every ${POLL_EVERY_MS / 1000} s for up to ${POLL_FOR_MS / 60_000} minutes...`,
  );
  while (true) {
    batch = await paypal.getPayoutBatch(batchId);
    console.log(`  ${new Date().toISOString()} batch ${batch.batchStatus}`);
    const settled = batch.batchStatus !== "PENDING" && batch.batchStatus !== "PROCESSING";
    if (settled || Date.now() + POLL_EVERY_MS > deadline) break;
    await sleep(POLL_EVERY_MS);
  }
} catch (error) {
  fail(`could not read payout batch ${batchId}`, error, hintsFor(error));
}

console.log("");
printBatch(batch);
const item = batch.items[0];
const itemOk = item?.transactionStatus === "SUCCESS" || item?.transactionStatus === "UNCLAIMED";

if (batch.batchStatus === "SUCCESS" && itemOk) {
  pass(`payout batch ${batch.batchId} is SUCCESS, item is ${item?.transactionStatus}`);
} else if (batch.batchStatus === "PENDING" || batch.batchStatus === "PROCESSING") {
  fail(`payout batch still ${batch.batchStatus} after ${POLL_FOR_MS / 60_000} minutes`);
} else {
  fail(`payout batch is ${batch.batchStatus}, item is ${item?.transactionStatus ?? "missing"}`);
}
