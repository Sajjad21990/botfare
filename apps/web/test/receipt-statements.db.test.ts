/**
 * Signed receipts over real HTTP: an official @x402/fetch agent pays a publisher running botfare()
 * (@x402/express); the payment statement arrives in the agent's PAYMENT-RESPONSE header as
 * extra.botfareReceipt, the middleware's attestation produces a delivery statement, a refund a
 * refund statement, and everything verifies offline against the published JWKS.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AGENT_HEADER } from "@botfare/contracts";
import { contentDigestSha256 } from "@botfare/contracts/fare";
import {
  RECEIPT_KEYS_PATH,
  type ReceiptStatements,
  receiptStatementsPath,
  SETTLE_EXTRA_RECEIPT_KEY,
  verifyStatement,
} from "@botfare/contracts/receipts";
import { type ReceiptKeyring, receiptKeyringFromEnv, setReceiptKeyring } from "@botfare/core";
import { botfare } from "@botfare/express";
import { PAYPAL_SANDBOX } from "@botfare/x402-paypal";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import express from "express";
import type { JSONWebKeySet } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as receiptKeys } from "../src/app/.well-known/botfare-receipt-keys.json/route";
import { GET as statementsRoute } from "../src/app/api/receipts/[receiptId]/statements/route";
import { GET as siteConfig } from "../src/app/api/sites/[siteId]/config/route";
import { POST as attest } from "../src/app/api/x402/receipts/[receiptId]/attest/route";
import { POST as refund } from "../src/app/api/x402/refund/route";
import { POST as settle } from "../src/app/api/x402/settle/route";
import { GET as supported } from "../src/app/api/x402/supported/route";
import { POST as verify } from "../src/app/api/x402/verify/route";
import { closeDb, getDb } from "../src/lib/server/db";
import { resetFacilitator } from "../src/lib/server/facilitator";
import {
  resetStatementLimits,
  STATEMENT_LOOKUPS_PER_MINUTE,
} from "../src/lib/server/receipt-statements";
import { makeAgent, makePublisher, postJson, useTestDatabase } from "./helpers";

// Route handlers run outside Next: no "server-only" guard.
vi.mock("server-only", () => ({}));

type Handler = (request: Request) => Response | Promise<Response>;

function routeHandlers(request: Request): Promise<Response> | Response {
  const { pathname } = new URL(request.url);
  const routes: Record<string, Handler> = {
    "GET /api/x402/supported": () => supported(),
    "POST /api/x402/verify": verify,
    "POST /api/x402/settle": settle,
  };
  const config = /^\/api\/sites\/([^/]+)\/config$/.exec(pathname);
  if (request.method === "GET" && config?.[1]) {
    const siteId = decodeURIComponent(config[1]);
    return siteConfig(request, { params: Promise.resolve({ siteId }) });
  }
  const attestPath = /^\/api\/x402\/receipts\/([^/]+)\/attest$/.exec(pathname);
  if (request.method === "POST" && attestPath?.[1]) {
    const receiptId = decodeURIComponent(attestPath[1]);
    return attest(request, { params: Promise.resolve({ receiptId }) });
  }
  const route = routes[`${request.method} ${pathname}`];
  return route ? route(request) : new Response("not found", { status: 404 });
}

function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function startBotFare() {
  return listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const response = await routeHandlers(
        new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method,
          headers,
          body: hasBody ? Buffer.concat(chunks) : undefined,
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    }),
  );
}

async function getStatements(receiptId: string, ip = "203.0.113.7"): Promise<Response> {
  const request = new Request(`https://botfare.example${receiptStatementsPath(receiptId)}`, {
    headers: { "x-forwarded-for": ip },
  });
  return statementsRoute(request, { params: Promise.resolve({ receiptId }) });
}

async function jwks(): Promise<JSONWebKeySet> {
  return (await receiptKeys()).json();
}

let keyring: ReceiptKeyring;
let botfareServer: Awaited<ReturnType<typeof startBotFare>>;
beforeAll(async () => {
  useTestDatabase();
  keyring = await receiptKeyringFromEnv({
    BOTFARE_RECEIPT_KEY_SEED: "web-test-receipt-seed-0123456789-abcdefgh",
    BOTFARE_RECEIPT_KEY_SEED_PREVIOUS: "web-test-old-receipt-seed-0123456789-abcd",
    BOTFARE_URL: "https://botfare.example",
    NODE_ENV: "test",
  });
  setReceiptKeyring(keyring);
  botfareServer = await startBotFare();
});
beforeEach(() => resetStatementLimits());
afterAll(async () => {
  await botfareServer?.close();
  setReceiptKeyring(undefined);
  resetFacilitator();
  await closeDb();
});

const ARTICLE = "<h1>grinders</h1><p>Burr sets, conical and flat.</p>";

describe("signed receipts end to end", () => {
  it("puts the payment statement in the agent's PAYMENT-RESPONSE; delivery and refund follow", async () => {
    const db = getDb();
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, 100);

    const app = express();
    app.use(
      botfare({
        siteId: publisher.site.id,
        siteSecret: publisher.siteSecret,
        botfareUrl: botfareServer.url,
        logger: () => {},
      }),
    );
    app.get("/articles/:slug", (_req, res) => {
      res.type("html").send(ARTICLE);
    });
    const site = await listen(createServer(app));

    try {
      const agentFetch: typeof fetch = (input, init) => {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        headers.set(AGENT_HEADER, "receipts-agent");
        return fetch(input, { ...init, headers });
      };
      const payingFetch = wrapFetchWithPayment(
        agentFetch,
        new x402Client().register(PAYPAL_SANDBOX, agent.client),
      );
      let res = await payingFetch(`${site.url}/articles/grinders`);
      for (let i = 0; i < 20 && res.status === 503; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        res = await payingFetch(`${site.url}/articles/grinders`);
      }
      expect(res.status).toBe(200);
      const body = await res.text();

      // Where the agent reads it: PAYMENT-RESPONSE → decode → extra.botfareReceipt.
      const settlement = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE") ?? "");
      expect(settlement.success).toBe(true);
      const receiptId = settlement.transaction;
      const payment = settlement.extra?.[SETTLE_EXTRA_RECEIPT_KEY];
      expect(typeof payment).toBe("string");

      const keys = await jwks();
      const verified = await verifyStatement(payment as string, keys, {
        issuer: "https://botfare.example",
        kind: "payment",
      });
      expect(verified.ok).toBe(true);
      if (!verified.ok || verified.statement.kind !== "payment") throw new Error("unverified");
      expect(verified.statement.sub).toBe(receiptId);
      expect(verified.statement.payment).toMatchObject({
        payTo: publisher.site.id,
        payer: agent.key.id,
        amount: "3",
        amountMicros: 30_000,
        resource: `${site.url}/articles/grinders`,
        signal: expect.any(String),
      });

      // The middleware attests the delivered bytes in the background → delivery statement.
      let statements: ReceiptStatements | null = null;
      for (let i = 0; i < 50; i++) {
        statements = await (await getStatements(receiptId)).json();
        if (statements?.delivery) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(statements?.payment).toBe(payment);
      const delivery = await verifyStatement(statements?.delivery as string, keys, {
        kind: "delivery",
      });
      expect(delivery.ok && delivery.statement).toMatchObject({
        sub: receiptId,
        delivery: { contentDigest: await contentDigestSha256(body), status: 200 },
      });

      // The publisher refunds → refund statement.
      const refunded = await refund(
        postJson(
          "https://botfare.example/api/x402/refund",
          { transaction: receiptId },
          publisher.auth,
        ),
      );
      expect(refunded.status).toBe(200);
      const after: ReceiptStatements = await (await getStatements(receiptId)).json();
      expect(after.payment).toBe(payment);
      expect(after.delivery).toBe(statements?.delivery);
      const refundStatement = await verifyStatement(after.refund as string, keys, {
        kind: "refund",
      });
      expect(refundStatement.ok && refundStatement.statement).toMatchObject({
        sub: receiptId,
        refund: { via: "publisher", disputeId: null, refundedMicros: 30_000 },
      });
    } finally {
      await site.close();
    }
  });

  it("settles without a statement when signing is disabled (production without a seed)", async () => {
    const db = getDb();
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, 100);
    setReceiptKeyring(
      await receiptKeyringFromEnv({
        NODE_ENV: "production",
        BOTFARE_URL: "https://botfare.example",
      }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const requirements = {
        scheme: "prepaid",
        network: PAYPAL_SANDBOX,
        asset: "USD",
        amount: "3",
        payTo: publisher.site.id,
        maxTimeoutSeconds: 60,
        extra: {},
      };
      const created = await agent.client.createPaymentPayload(2, requirements);
      const paymentPayload = {
        x402Version: 2,
        resource: { url: "https://crema.example/articles/grinders" },
        accepted: requirements,
        payload: created.payload,
      };
      const res = await settle(
        postJson(
          "https://botfare.example/api/x402/settle",
          { x402Version: 2, paymentPayload, paymentRequirements: requirements },
          publisher.auth,
        ),
      );
      const result = await res.json();
      expect(result).toMatchObject({ success: true });
      expect(result.transaction).toMatch(/^rcpt_/);
      expect(result.extra).toBeUndefined();
      expect(await (await getStatements(result.transaction)).json()).toMatchObject({
        payment: null,
      });

      // Once a key is configured, the lookup issues the missing statement.
      setReceiptKeyring(keyring);
      const later: ReceiptStatements = await (await getStatements(result.transaction)).json();
      expect((await verifyStatement(later.payment as string, await jwks())).ok).toBe(true);
    } finally {
      errors.mockRestore();
      setReceiptKeyring(keyring);
    }
  });
});

describe("receipt key directory and statements endpoint", () => {
  it("publishes active and previous public keys only, cacheable and CORS-open", async () => {
    const res = await receiptKeys();
    expect(res.headers.get("content-type")).toBe("application/jwk-set+json");
    expect(res.headers.get("cache-control")).toMatch(/public, max-age=\d+/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body.keys).toHaveLength(2);
    expect(body.keys[0]).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
      use: "sig",
      kid: keyring.active?.kid,
    });
    for (const key of body.keys)
      expect(Object.keys(key).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
    expect(RECEIPT_KEYS_PATH).toBe("/.well-known/botfare-receipt-keys.json");
  });

  it("answers 404 for unknown or malformed receipt IDs", async () => {
    expect((await getStatements("rcpt_doesnotexist000")).status).toBe(404);
    expect((await getStatements("not-a-receipt")).status).toBe(404);
    expect((await getStatements(`rcpt_${"x".repeat(200)}`)).status).toBe(404);
  });

  it("rate-limits lookups per client IP", async () => {
    for (let i = 0; i < STATEMENT_LOOKUPS_PER_MINUTE; i++) {
      expect((await getStatements("bad", "198.51.100.9")).status).toBe(404);
    }
    const limited = await getStatements("bad", "198.51.100.9");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await getStatements("bad", "198.51.100.10")).status).toBe(404);
  });
});
