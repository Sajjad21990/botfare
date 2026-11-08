// Spike 02b: capture an order that was approved but not captured (e.g. spike 02 timed out).
// Usage: pnpm spike:02b <orderId>
import { fail, pass, paypalFromEnv, printCapture } from "./_env";

const orderId = process.argv[2];
if (!orderId) {
  console.error("Usage: pnpm spike:02b <orderId>");
  process.exit(1);
}

const paypal = paypalFromEnv();

try {
  console.log(`Capturing order ${orderId}...`);
  const capture = await paypal.captureOrder(orderId);
  printCapture(capture);
  pass(`top-up captured (${capture.captureStatus})`);
} catch (error) {
  fail(`could not capture order ${orderId}`, error, [
    "ORDER_NOT_APPROVED means the payer has not approved it yet; open the approve URL first.",
    "ORDER_ALREADY_CAPTURED means it was captured already.",
  ]);
}
