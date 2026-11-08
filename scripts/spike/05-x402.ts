/**
 * Spike 05: prove BotFare's PayPal payment type works as a plug-in for the official x402 SDK.
 *
 * A publisher site runs the official @x402/express middleware, an agent uses the official
 * @x402/fetch wrapper, and a facilitator built on @x402/core's x402Facilitator settles into an
 * in-memory ledger. All three have the `prepaid` scheme on `paypal:sandbox` registered.
 */
import type { AddressInfo } from "node:net";
import {
  generateAgentKeyPair,
  InMemoryLedger,
  PAYPAL_SANDBOX,
  PREPAID_SCHEME,
  PrepaidPayPalClient,
  PrepaidPayPalFacilitator,
  PrepaidPayPalServer,
} from "@botfare/x402-paypal";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import express from "express";

const SITE_ID = "site_demo";
let failures = 0;

function report(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

function listen(app: express.Express): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

// --- Ledger: one agent key with a $1.00 wallet ---
const ledger = new InMemoryLedger();
const { publicJwk, privateJwk } = await generateAgentKeyPair();
const keyId = "ak_spike";
ledger.addKey({
  keyId,
  publicJwk,
  walletId: "owner_1",
  perRequestMaxCents: 10,
  dailyCapCents: 100,
});
ledger.topUp("owner_1", 100);
const wallet = () => ledger.balanceMicros("wallet:owner_1");

// --- Facilitator: the official x402Facilitator with our scheme, over HTTP ---
const facilitator = new x402Facilitator().register(
  PAYPAL_SANDBOX,
  new PrepaidPayPalFacilitator({ ledger }),
);
const facilitatorApp = express().use(express.json());
facilitatorApp.get("/supported", (_req, res) => {
  res.json(facilitator.getSupported());
});
facilitatorApp.post("/verify", async (req, res) => {
  res.json(await facilitator.verify(req.body.paymentPayload, req.body.paymentRequirements));
});
facilitatorApp.post("/settle", async (req, res) => {
  res.json(await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements));
});
const facilitatorServer = await listen(facilitatorApp);

// --- Publisher: the official @x402/express middleware with our scheme ---
const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: facilitatorServer.url }),
).register(PAYPAL_SANDBOX, new PrepaidPayPalServer());

const accepts = { scheme: PREPAID_SCHEME, network: PAYPAL_SANDBOX, payTo: SITE_ID, price: "$0.03" };
const site = express();
site.use(
  paymentMiddleware(
    {
      "GET /articles/burr-basics": {
        accepts,
        description: "Burr grinders, explained",
        mimeType: "text/html",
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: { preview: "Burr grinders crush beans between two abrasive surfaces..." },
        }),
      },
      "GET /boom": { accepts, description: "A handler that fails", mimeType: "application/json" },
    },
    resourceServer,
  ),
);
site.get("/articles/burr-basics", (_req, res) => {
  res.type("html").send("<h1>Burr grinders, explained</h1><p>The full article.</p>");
});
site.get("/boom", (_req, res) => {
  res.status(500).json({ error: "handler crashed" });
});
const siteServer = await listen(site);

// --- Agent: the official @x402/fetch wrapper with our scheme ---
let lastPaymentSignature: string | undefined;
const recordingFetch: typeof fetch = async (input, init) => {
  const signature = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
  lastPaymentSignature = signature.get("PAYMENT-SIGNATURE") ?? lastPaymentSignature;
  return fetch(input, init);
};
const client = new x402Client().register(
  PAYPAL_SANDBOX,
  new PrepaidPayPalClient({ keyId, privateJwk }),
);
const payingFetch = wrapFetchWithPayment(recordingFetch, client);
const articleUrl = `${siteServer.url}/articles/burr-basics`;

try {
  // 1. Unpaid request gets a 402 with a V2 PAYMENT-REQUIRED header
  const unpaid = await fetch(articleUrl);
  const header = unpaid.headers.get("PAYMENT-REQUIRED");
  const required = header ? decodePaymentRequiredHeader(header) : undefined;
  console.log("\nDecoded PAYMENT-REQUIRED:\n", JSON.stringify(required, null, 2));
  console.log("402 body:", await unpaid.text(), "\n");
  const offer = required?.accepts[0];
  report(
    "402 with V2 PAYMENT-REQUIRED for prepaid on paypal:sandbox",
    unpaid.status === 402 &&
      required?.x402Version === 2 &&
      offer?.scheme === "prepaid" &&
      offer?.network === "paypal:sandbox" &&
      offer?.asset === "USD" &&
      offer?.amount === "3" &&
      offer?.payTo === SITE_ID,
    `status=${unpaid.status}`,
  );

  // 2. Paid retry returns 200 with a successful PAYMENT-RESPONSE and moves 3 cents
  const before = wallet();
  const paid = await payingFetch(articleUrl);
  const paymentResponse = paid.headers.get("PAYMENT-RESPONSE");
  const settlement = paymentResponse ? decodePaymentResponseHeader(paymentResponse) : undefined;
  console.log("\nDecoded PAYMENT-RESPONSE:\n", JSON.stringify(settlement, null, 2), "\n");
  report(
    "Paid request returns 200 with PAYMENT-RESPONSE success",
    paid.status === 200 && settlement?.success === true && (await paid.text()).includes("<h1>"),
    `status=${paid.status} transaction=${settlement?.transaction}`,
  );
  report(
    "Wallet charged exactly 3 cents; publisher gets 95%, BotFare 5%",
    before - wallet() === 30_000 &&
      ledger.balanceMicros(`earnings:${SITE_ID}`) === 28_500 &&
      ledger.balanceMicros("platform:fees") === 1_500,
    `wallet ${before} -> ${wallet()} micros`,
  );

  // 3. Replaying the same PAYMENT-SIGNATURE is rejected and charges nothing
  const beforeReplay = wallet();
  const replay = await fetch(articleUrl, {
    headers: { "PAYMENT-SIGNATURE": lastPaymentSignature ?? "" },
  });
  const replayRequired = replay.headers.get("PAYMENT-REQUIRED");
  const replayReason = replayRequired ? decodePaymentRequiredHeader(replayRequired).error : "";
  report(
    "Replayed payment rejected",
    Boolean(lastPaymentSignature) && replay.status !== 200 && wallet() === beforeReplay,
    `status=${replay.status} reason=${replayReason}`,
  );

  // 4. A failing handler is not charged
  const beforeBoom = wallet();
  const boom = await payingFetch(`${siteServer.url}/boom`);
  report(
    "Handler error (500) is not charged",
    boom.status === 500 && wallet() === beforeBoom,
    `status=${boom.status} wallet unchanged=${wallet() === beforeBoom}`,
  );

  report("Ledger balances sum to zero", ledger.totalMicros() === 0);
} catch (err) {
  report("Spike ran without throwing", false, String(err));
} finally {
  siteServer.close();
  facilitatorServer.close();
}

console.log(failures === 0 ? "\nSpike 05: ALL PASS" : `\nSpike 05: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
