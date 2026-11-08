/**
 * In-process x402 stack for SDK tests: a publisher on the official @x402/express middleware and a
 * facilitator on x402Facilitator, both with BotFare's plug-in, settling into an InMemoryLedger.
 */
import type { AddressInfo } from "node:net";
import { AGENT_HEADER, encodeAgentKey } from "@botfare/contracts";
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

export const SITE_ID = "site_testpub";
export const KEY_ID = "ak_sdktest";
export const WALLET = `wallet:owner_sdk`;

export const ARTICLE_PREVIEW = {
  title: "Burr grinders, explained",
  excerpt: "Burr grinders crush beans between two abrasive surfaces...",
  wordCount: 1200,
};

export interface SeenRequest {
  path: string;
  agentHeader: string | undefined;
  paymentSignature: boolean;
  /** Host, URL and headers as the publisher received them (for signature checks). */
  host: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

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
  // The facilitator allows up to $1 per request, so the SDK's own cap is what refuses $0.25.
  ledger.addKey({
    keyId: KEY_ID,
    publicJwk,
    walletId: "owner_sdk",
    perRequestMaxCents: 100,
    dailyCapCents: 500,
  });
  ledger.topUp("owner_sdk", 100);
  const agentKey = encodeAgentKey({
    v: 1,
    keyId: KEY_ID,
    privateJwk: privateJwk as { kty: "OKP"; crv: "Ed25519"; x: string; d: string },
  });

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

  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: facilitatorServer.url }),
  ).register(PAYPAL_SANDBOX, new PrepaidPayPalServer());
  const accepts = (price: string) => ({
    scheme: PREPAID_SCHEME,
    network: PAYPAL_SANDBOX,
    payTo: SITE_ID,
    price,
  });

  const seen: SeenRequest[] = [];
  const site = express();
  site.use((req, _res, next) => {
    seen.push({
      path: req.path,
      agentHeader: req.header(AGENT_HEADER),
      paymentSignature: Boolean(req.header("PAYMENT-SIGNATURE")),
      host: req.headers.host ?? "",
      url: req.originalUrl,
      headers: { ...req.headers },
    });
    next();
  });
  site.use(
    paymentMiddleware(
      {
        "GET /articles/burr-basics": {
          accepts: accepts("$0.03"),
          description: "Burr grinders, explained",
          mimeType: "text/html",
          unpaidResponseBody: () => ({
            contentType: "application/json",
            body: { preview: ARTICLE_PREVIEW },
          }),
        },
        "GET /articles/moved": {
          accepts: accepts("$0.03"),
          description: "An article that redirects paying agents",
          mimeType: "text/html",
        },
        "GET /reports/deep-dive": {
          accepts: accepts("$0.25"),
          description: "A long report",
          mimeType: "text/html",
        },
      },
      resourceServer,
    ),
  );
  site.get("/articles/burr-basics", (_req, res) => {
    res.type("html").send("<h1>Burr grinders, explained</h1><p>The full article.</p>");
  });
  site.get("/articles/moved", (_req, res) => {
    res.redirect(302, "/free");
  });
  site.get("/reports/deep-dive", (_req, res) => {
    res.type("html").send("<h1>Deep dive</h1>");
  });
  site.get("/free", (_req, res) => {
    res.json({ free: true });
  });
  const siteServer = await listen(site);

  return {
    ledger,
    agentKey,
    publicJwk,
    seen,
    siteUrl: siteServer.url,
    wallet: () => ledger.balanceMicros(WALLET),
    async stop() {
      await siteServer.close();
      await facilitatorServer.close();
    },
  };
}
