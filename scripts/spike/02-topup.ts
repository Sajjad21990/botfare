// Spike 02: an agent owner tops up $5.00 through PayPal Checkout, and we capture it.
// Creates an order, waits for PayPal to redirect back to localhost:4402, then captures.
import { createServer, type ServerResponse } from "node:http";
import { fail, pass, paypalFromEnv, printCapture } from "./_env";

const PORT = 4402;
const RETURN_URL = `http://localhost:${PORT}/return`;
const CANCEL_URL = `http://localhost:${PORT}/cancel`;
const TIMEOUT_MS = 10 * 60 * 1000;

type Outcome =
  | { kind: "return"; token: string | null; payerId: string | null }
  | { kind: "cancel" }
  | { kind: "timeout" };

const paypal = paypalFromEnv();

function page(res: ServerResponse, status: number, title: string, text: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>${title}</h1><p>${text}</p></body>`,
  );
}

// Start listening before creating the order, so a busy port fails fast.
let respond: ((status: number, title: string, text: string) => void) | undefined;
let settle: (outcome: Outcome) => void = () => {};
const outcome = new Promise<Outcome>((resolve) => {
  settle = resolve;
});

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/return" && !respond) {
    // Keep the tab waiting until the capture finishes, then answer it.
    respond = (status, title, text) => page(res, status, title, text);
    settle({
      kind: "return",
      token: url.searchParams.get("token"),
      payerId: url.searchParams.get("PayerID"),
    });
  } else if (url.pathname === "/cancel") {
    page(res, 200, "Top-up cancelled", "You can close this tab.");
    settle({ kind: "cancel" });
  } else {
    page(res, 404, "Not found", "BotFare spike 02 only handles /return and /cancel.");
  }
});

await new Promise<void>((resolve) => {
  server.once("error", (error) => fail(`could not listen on port ${PORT}`, error));
  server.listen(PORT, resolve);
});

function shutdown(): void {
  // Stop accepting connections; idle keep-alive sockets are closed once responses finish.
  server.close();
  server.closeIdleConnections();
}

let orderId: string;
try {
  console.log("Creating a $5.00 USD order...");
  const order = await paypal.createOrder({
    amount: "5.00",
    currency: "USD",
    returnUrl: RETURN_URL,
    cancelUrl: CANCEL_URL,
    description: "BotFare spike top-up",
    customId: `spike_topup_${Date.now()}`,
  });
  orderId = order.id;
  console.log(`  order ID: ${order.id} (${order.status})`);
  console.log("\nOpen this URL and log in as the sandbox AGENT-OWNER (personal) account:\n");
  console.log(`  ${order.approveUrl}\n`);
  console.log(`Waiting up to ${TIMEOUT_MS / 60_000} minutes for PayPal to redirect back...`);
} catch (error) {
  shutdown();
  fail("could not create the order", error);
}

const timer = setTimeout(() => settle({ kind: "timeout" }), TIMEOUT_MS);
const result = await outcome;
clearTimeout(timer);

const captureHint = `once the order is approved, capture it with: pnpm spike:02b ${orderId}`;

if (result.kind !== "return") {
  shutdown();
  fail(
    result.kind === "cancel" ? "the payer cancelled the top-up" : "timed out waiting for approval",
    undefined,
    [captureHint],
  );
}

console.log(`\nRedirected back (token=${result.token}, PayerID=${result.payerId}).`);
if (result.token && result.token !== orderId) {
  console.warn(`Warning: redirect token ${result.token} does not match order ${orderId}.`);
}

try {
  console.log("Capturing...");
  const capture = await paypal.captureOrder(orderId);
  printCapture(capture);
  respond?.(200, "Top-up captured", "Top-up captured, you can close this tab.");
  shutdown();
  pass(`top-up captured (${capture.captureStatus})`);
  // Give the browser a moment to receive the page, then exit even if it keeps a socket open.
  setTimeout(() => process.exit(0), 500);
} catch (error) {
  respond?.(500, "Capture failed", "The capture failed; see the terminal for details.");
  shutdown();
  fail(`could not capture order ${orderId}`, error, [captureHint]);
}
