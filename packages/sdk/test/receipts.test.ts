import type { AddressInfo } from "node:net";
import { contentDigestSha256 } from "@botfare/contracts/fare";
import {
  type BotFareStatement,
  publicJwk,
  RECEIPT_JWT_TYPE,
  RECEIPT_KEYS_PATH,
  type ReceiptStatements,
} from "@botfare/contracts/receipts";
import express from "express";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BotFareApiError,
  createBotFareAgent,
  createReceiptVerifier,
  readReceiptStatement,
  verifyReceipt,
} from "../src";
import { KEY_ID, SITE_ID, startStack } from "./harness";

/** Signed receipts on the agent side, against a fake BotFare that signs with a key made here. */

const KID = "rk_test_1";
const ARTICLE_HTML = "<h1>Burr grinders, explained</h1><p>The full article.</p>";

type Signer = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
/** Statement claims without the ones `sign` fills in (distributed over the kinds). */
type Claims = BotFareStatement extends infer S
  ? S extends BotFareStatement
    ? Omit<S, "iss" | "iat" | "v"> & { iss?: string }
    : never
  : never;

let stack: Awaited<ReturnType<typeof startStack>>;
let botfare: { url: string; close: () => Promise<void> };
let privateKey: Signer;
let otherKey: Signer;
let jwk: JWK;
let keyFetches = 0;
/** Whether the facilitator adds a signed payment statement to its settle response. */
let signAtSettle = true;
const statements = new Map<string, ReceiptStatements>();

async function sign(claims: Claims, key: Signer = privateKey, kid = KID): Promise<string> {
  return new SignJWT({ v: 1, iss: botfare.url, ...claims } as Record<string, unknown>)
    .setProtectedHeader({ alg: "EdDSA", typ: RECEIPT_JWT_TYPE, kid })
    .setIssuedAt()
    .sign(key);
}

function paymentClaims(receiptId: string, resource: string | null) {
  return {
    sub: receiptId,
    kind: "payment" as const,
    payment: {
      scheme: "prepaid",
      network: "paypal:sandbox",
      asset: "USD",
      amount: "3",
      amountMicros: 30_000,
      publisherMicros: 28_500,
      feeMicros: 1_500,
      payTo: SITE_ID,
      siteOrigin: null,
      resource,
      payer: KEY_ID,
      payerThumbprint: null,
      signal: null,
      offerDigest: null,
      settledAt: new Date().toISOString(),
    },
  };
}

async function deliveryStatement(receiptId: string, body: string): Promise<string> {
  return sign({
    sub: receiptId,
    kind: "delivery",
    delivery: {
      contentDigest: await contentDigestSha256(body),
      contentLength: new TextEncoder().encode(body).length,
      contentType: "text/html",
      status: 200,
      attestedAt: new Date().toISOString(),
    },
  });
}

beforeAll(async () => {
  ({ privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true }));
  ({ privateKey: otherKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" }));
  // Only the public half is published (publicJwk drops `d`).
  jwk = publicJwk({ ...(await exportJWK(privateKey)), kid: KID, alg: "EdDSA", use: "sig" });
  expect(jwk).not.toHaveProperty("d");

  const app = express();
  app.get(RECEIPT_KEYS_PATH, (_req, res) => {
    keyFetches += 1;
    res.json({ keys: [jwk] });
  });
  app.get("/api/receipts/:id/statements", (req, res) => {
    const found = statements.get(req.params.id);
    if (!found) {
      res.status(404).json({ error: "not_found", message: "No such receipt" });
      return;
    }
    res.json(found);
  });
  botfare = await new Promise((resolve) => {
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

  stack = await startStack({
    async decorateSettle(settle, requirements) {
      if (!signAtSettle) return settle;
      const token = await sign(
        paymentClaims(settle.transaction, (requirements.extra?.resource as string) ?? null),
      );
      statements.set(settle.transaction, {
        receiptId: settle.transaction,
        payment: token,
        delivery: null,
        refund: null,
      });
      return { ...settle, extra: { ...settle.extra, botfareReceipt: token } };
    },
  });
});

afterAll(async () => {
  await stack.stop();
  await botfare.close();
});

describe("PaidResult carries the signed receipt and a digest of the bytes read", () => {
  it("returns the payment statement from PAYMENT-RESPONSE and verifies it with the cached JWKS", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: botfare.url });
    const result = await agent.fetch(`${stack.siteUrl}/articles/burr-basics`);

    expect(result.paid).toBe(true);
    expect(result.receiptStatement).toEqual(expect.any(String));
    expect(readReceiptStatement(result.receipt)).toBe(result.receiptStatement);
    expect(result.readDigest).toBe(await contentDigestSha256(ARTICLE_HTML));
    expect(await result.response.text()).toBe(ARTICLE_HTML);

    const before = keyFetches;
    const verified = await agent.verifyReceipt(result.receiptStatement as string, {
      kind: "payment",
      receiptId: result.receiptId as string,
    });
    expect(verified).toMatchObject({ ok: true, kid: KID });
    if (!verified.ok || verified.statement.kind !== "payment") throw new Error("not verified");
    expect(verified.statement.sub).toBe(result.receiptId);
    expect(verified.statement.iss).toBe(botfare.url);
    expect(verified.statement.payment).toMatchObject({
      amount: "3",
      payTo: SITE_ID,
      payer: KEY_ID,
    });

    // A second check reuses the keys.
    expect((await agent.verifyReceipt(result.receiptStatement as string)).ok).toBe(true);
    expect(keyFetches - before).toBe(1);
  });

  it("has no statement or digest for a free page, nor a statement when BotFare signed none", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: botfare.url });
    const free = await agent.fetch(`${stack.siteUrl}/free`);
    expect(free).toMatchObject({ paid: false, receiptStatement: null, readDigest: null });
    await free.response.body?.cancel();

    signAtSettle = false;
    try {
      const unsigned = await agent.fetch(`${stack.siteUrl}/articles/burr-basics`);
      expect(unsigned.paid).toBe(true);
      expect(unsigned.receiptStatement).toBeNull();
      expect(unsigned.readDigest).toBe(await contentDigestSha256(ARTICLE_HTML));
    } finally {
      signAtSettle = true;
    }
  });
});

describe("verifyReceipt", () => {
  it("rejects a tampered statement, an unknown key, another issuer and another receipt", async () => {
    const verifier = createReceiptVerifier({ botfareUrl: botfare.url });
    const token = await sign(paymentClaims("rcpt_0123456789abcdef", null));
    expect((await verifier.verify(token)).ok).toBe(true);

    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload as string, "base64url").toString());
    claims.payment.amountMicros = 1;
    const tampered = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    expect(await verifier.verify(tampered)).toMatchObject({ ok: false, error: "bad_signature" });

    const foreign = await sign(paymentClaims("rcpt_0123456789abcdef", null), otherKey, "rk_other");
    expect(await verifier.verify(foreign)).toMatchObject({ ok: false, error: "unknown_key" });

    const elsewhere = await sign({
      ...paymentClaims("rcpt_0123456789abcdef", null),
      iss: "https://botfare.example",
    });
    expect(await verifier.verify(elsewhere)).toMatchObject({ ok: false, error: "wrong_issuer" });

    expect(await verifier.verify(token, { receiptId: "rcpt_ffffffffffffffff" })).toMatchObject({
      ok: false,
      error: "invalid_claims",
    });
    expect(await verifier.verify(token, { kind: "delivery" })).toMatchObject({
      ok: false,
      error: "invalid_claims",
    });
    expect(await verifier.verify("not a jws")).toMatchObject({ ok: false, error: "malformed" });
  });

  it("refetches the keys for an unknown kid (rotation), at most every 30 s", async () => {
    let now = 1_000_000;
    const verifier = createReceiptVerifier({ botfareUrl: botfare.url, now: () => now });
    const foreign = await sign(paymentClaims("rcpt_0123456789abcdef", null), otherKey, "rk_other");
    const before = keyFetches;
    await verifier.verify(foreign);
    await verifier.verify(foreign);
    expect(keyFetches - before).toBe(1);
    now += 31_000;
    await verifier.verify(foreign);
    expect(keyFetches - before).toBe(2);
  });

  it("works standalone, and says when the keys cannot be fetched", async () => {
    const token = await sign(paymentClaims("rcpt_0123456789abcdef", null));
    expect(await verifyReceipt(token, { botfareUrl: `${botfare.url}/some/page` })).toMatchObject({
      ok: true,
    });
    const unreachable = await verifyReceipt(token, {
      botfareUrl: "http://127.0.0.1:9",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    expect(unreachable).toMatchObject({ ok: false, error: "keys_unavailable" });
    expect(await verifyReceipt(token, { botfareUrl: "not a url" })).toMatchObject({
      ok: false,
      error: "keys_unavailable",
    });
  });
});

describe("agent.fetchStatements", () => {
  it("returns the payment statement, then the delivery statement once attested", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: botfare.url });
    const result = await agent.fetch(`${stack.siteUrl}/articles/burr-basics`);
    const receiptId = result.receiptId as string;

    const first = await agent.fetchStatements(receiptId);
    expect(first).toEqual({
      receiptId,
      payment: result.receiptStatement,
      delivery: null,
      refund: null,
    });

    const delivery = await deliveryStatement(receiptId, ARTICLE_HTML);
    statements.set(receiptId, { ...(first as ReceiptStatements), delivery });
    const second = await agent.fetchStatements(receiptId);
    const verified = await agent.verifyReceipt(second?.delivery as string, {
      kind: "delivery",
      receiptId,
    });
    if (!verified.ok || verified.statement.kind !== "delivery") throw new Error("not verified");
    expect(verified.statement.delivery.contentDigest).toBe(result.readDigest);

    expect(await agent.fetchStatements("rcpt_ffffffffffffffff")).toBeNull();
  });

  it("needs a BotFare URL", async () => {
    vi.stubEnv("BOTFARE_URL", "");
    try {
      const agent = createBotFareAgent({ agentKey: stack.agentKey });
      expect(await agent.verifyReceipt("a.b.c")).toMatchObject({
        ok: false,
        error: "keys_unavailable",
      });
      await expect(agent.fetchStatements("rcpt_0123456789abcdef")).rejects.toBeInstanceOf(
        BotFareApiError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
