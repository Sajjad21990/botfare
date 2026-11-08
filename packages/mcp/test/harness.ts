/**
 * In-process stack for the MCP tests: a publisher on the official @x402/express middleware, a
 * facilitator on x402Facilitator (both with BotFare's plug-in, settling into an InMemoryLedger),
 * and a stand-in for BotFare's agent API (/api/agent/wallet, /api/agent/receipts) that
 * authenticates requests by their Web Bot Auth signature, like apps/web does.
 */
import type { AddressInfo } from "node:net";
import { encodeAgentKey } from "@botfare/contracts";
import {
  type Ed25519PublicJwk,
  jwkThumbprint,
  verifySignedRequest,
} from "@botfare/contracts/web-bot-auth";
import {
  generateAgentKeyPair,
  InMemoryLedger,
  PAYPAL_SANDBOX,
  PREPAID_SCHEME,
  PrepaidPayPalFacilitator,
  PrepaidPayPalServer,
} from "@botfare/x402-paypal";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import express from "express";

export const SITE_ID = "site_mcptest";
export const KEY_ID = "ak_mcptest";
const WALLET_ID = "owner_mcp";
export const PER_REQUEST_MAX_CENTS = 5;
export const DAILY_CAP_CENTS = 8;
export const START_BALANCE_CENTS = 100;

export const ARTICLE_PREVIEW = {
  title: "Water temperature for pour-over",
  excerpt: "Most pour-over recipes call for water just off the boil...",
  wordCount: 900,
};

const ARTICLE_HTML = `<!doctype html><html><head><title>Water temperature for pour-over</title>
<style>body{font-family:serif}</style><script>console.log("tracking")</script></head>
<body><article><h1>Water temperature for pour-over</h1>
<p>Brew between 92&nbsp;&deg;C and 96 &#176;C &amp; adjust by roast.</p>
<ul><li>Light roasts: hotter</li><li>Dark roasts: cooler</li></ul></article></body></html>`;

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

export async function startStack() {
  const ledger = new InMemoryLedger();
  const { publicJwk, privateJwk } = await generateAgentKeyPair();
  ledger.addKey({
    keyId: KEY_ID,
    publicJwk,
    walletId: WALLET_ID,
    perRequestMaxCents: PER_REQUEST_MAX_CENTS,
    dailyCapCents: DAILY_CAP_CENTS,
  });
  ledger.topUp(WALLET_ID, START_BALANCE_CENTS);
  const agentKey = encodeAgentKey({
    v: 1,
    keyId: KEY_ID,
    privateJwk: privateJwk as { kty: "OKP"; crv: "Ed25519"; x: string; d: string },
  });
  const thumbprint = await jwkThumbprint(publicJwk as Ed25519PublicJwk);

  // Facilitator.
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

  // Publisher.
  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: facilitatorServer.url }),
  ).register(PAYPAL_SANDBOX, new PrepaidPayPalServer());
  const accepts = (price: string) => ({
    scheme: PREPAID_SCHEME,
    network: PAYPAL_SANDBOX,
    payTo: SITE_ID,
    price,
  });
  /** Payment signatures the publisher received, by path. */
  const paymentsSeen: string[] = [];
  const site = express();
  site.use((req, _res, next) => {
    if (req.header("PAYMENT-SIGNATURE")) paymentsSeen.push(req.path);
    next();
  });
  site.use(
    paymentMiddleware(
      {
        "GET /articles/water-temperature": {
          accepts: accepts("$0.03"),
          description: "Water temperature for pour-over",
          mimeType: "text/html",
          unpaidResponseBody: () => ({
            contentType: "application/json",
            body: { preview: ARTICLE_PREVIEW },
          }),
        },
        "GET /api/brew-ratio": {
          accepts: accepts("$0.01"),
          description: "Brew ratio calculator",
          mimeType: "application/json",
        },
        "GET /reports/annual": {
          accepts: accepts("$0.25"),
          description: "Annual coffee report",
          mimeType: "text/html",
        },
      },
      resourceServer,
    ),
  );
  site.get("/articles/water-temperature", (_req, res) => {
    res.type("html").send(ARTICLE_HTML);
  });
  site.get("/api/brew-ratio", (_req, res) => {
    res.json({ coffeeGrams: 20, waterGrams: 320, ratio: "1:16" });
  });
  site.get("/reports/annual", (_req, res) => {
    res.type("html").send("<h1>Annual report</h1>");
  });
  site.get("/free", (_req, res) => {
    res.type("html").send("<h1>Free page</h1><p>Open to everyone.</p>");
  });
  const siteServer = await listen(site);

  // BotFare agent API stand-in.
  let apiRequests = 0;
  const botfare = express();
  botfare.use(async (req, res, next) => {
    apiRequests += 1;
    const host = req.headers.host ?? "";
    const result = await verifySignedRequest({
      url: `http://${host}${req.originalUrl}`,
      authority: host,
      method: req.method,
      headers: req.headers,
      resolveKey: (keyid) => (keyid === thumbprint ? (publicJwk as Ed25519PublicJwk) : null),
    });
    if (!result.ok) {
      res.status(401).json({ error: "unauthorized", message: result.message });
      return;
    }
    next();
  });
  const spentTodayCents = () =>
    ledger.receipts.filter((r) => r.keyId === KEY_ID).reduce((sum, r) => sum + r.amountCents, 0);
  botfare.get("/api/agent/wallet", (_req, res) => {
    res.json({
      keyId: KEY_ID,
      keyName: "research agent",
      balanceUsd: ledger.balanceMicros(`wallet:${WALLET_ID}`) / 1_000_000,
      spentTodayUsd: spentTodayCents() / 100,
      dailyCapUsd: DAILY_CAP_CENTS / 100,
      perRequestMaxUsd: PER_REQUEST_MAX_CENTS / 100,
      allowedSiteIds: null,
    });
  });
  botfare.get("/api/agent/receipts", (req, res) => {
    const limit = Number(req.query.limit ?? 10);
    res.json({
      keyId: KEY_ID,
      receipts: [...ledger.receipts]
        .reverse()
        .slice(0, limit)
        .map((r) => ({
          receiptId: r.transaction,
          time: r.createdAt.toISOString(),
          site: "Crema Notes",
          siteId: r.payTo,
          url: r.resourceUrl ?? null,
          amountUsd: r.amountCents / 100,
          status: "settled",
        })),
    });
  });
  const botfareServer = await listen(botfare);

  return {
    ledger,
    agentKey,
    paymentsSeen,
    siteUrl: siteServer.url,
    botfareUrl: botfareServer.url,
    apiRequests: () => apiRequests,
    walletMicros: () => ledger.balanceMicros(`wallet:${WALLET_ID}`),
    async stop() {
      await siteServer.close();
      await facilitatorServer.close();
      await botfareServer.close();
    },
  };
}
