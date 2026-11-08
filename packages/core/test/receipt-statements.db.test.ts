import {
  decodeStatement,
  SETTLE_EXTRA_RECEIPT_KEY,
  verifyStatement,
} from "@botfare/contracts/receipts";
import { PrepaidPayPalClient, PrepaidPayPalFacilitator } from "@botfare/x402-paypal";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  applyVerdict,
  attestReceipt,
  declaredOfferDigest,
  deriveReceiptKey,
  getReceiptStatements,
  issueReceiptStatement,
  openDispute,
  PostgresPrepaidLedger,
  publisherDecide,
  type ReceiptKeyring,
  receiptJwks,
  receiptKeyringFromEnv,
  refundReceipt,
  schema,
  setReceiptKeyring,
} from "../src";
import { expectLedgerHealthy, makeAgent, makePublisher, openTestDb } from "./helpers";

const { db, close } = openTestDb();
const SEED = "test-receipt-seed-0123456789-abcdefghijklmnop";
const OLD_SEED = "old-receipt-seed-0123456789-abcdefghijklmnopq";

let keyring: ReceiptKeyring;
async function testKeyring(): Promise<ReceiptKeyring> {
  keyring ??= await receiptKeyringFromEnv({
    BOTFARE_RECEIPT_KEY_SEED: SEED,
    BOTFARE_RECEIPT_KEY_SEED_PREVIOUS: OLD_SEED,
    BOTFARE_URL: "https://botfare.example/some/path",
    NODE_ENV: "test",
  });
  // Statements issued by core's own hooks (attest, refund) use the process keyring.
  setReceiptKeyring(keyring);
  return keyring;
}

afterEach(() => expectLedgerHealthy(db));
afterAll(async () => {
  setReceiptKeyring(undefined);
  await close();
});

describe("receipt keys", () => {
  it("derives the same Ed25519 key from the same seed, a different one from another", async () => {
    const a = await deriveReceiptKey(SEED);
    const b = await deriveReceiptKey(SEED);
    const c = await deriveReceiptKey(OLD_SEED);
    expect(a.kid).toBe(b.kid);
    expect(a.publicJwk).toEqual(b.publicJwk);
    expect(a.publicJwk).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    expect(c.kid).not.toBe(a.kid);
    await expect(deriveReceiptKey("too-short")).rejects.toThrow(/at least 32/);
  });

  it("publishes active and previous keys, signs only with the active one, never exposes d", async () => {
    const ring = await testKeyring();
    expect(ring.issuer).toBe("https://botfare.example");
    expect(ring.active?.kid).toBe((await deriveReceiptKey(SEED)).kid);
    const jwks = receiptJwks(ring);
    expect(jwks.keys.map((k) => k.kid)).toEqual([
      (await deriveReceiptKey(SEED)).kid,
      (await deriveReceiptKey(OLD_SEED)).kid,
    ]);
    for (const key of jwks.keys) expect(key).not.toHaveProperty("d");
    expect(JSON.stringify(jwks)).not.toContain('"d"');
  });

  it("uses a labelled development seed outside production and refuses to sign in production", async () => {
    const dev = await receiptKeyringFromEnv({ NODE_ENV: "development" });
    expect(dev.development).toBe(true);
    expect(dev.active).not.toBeNull();
    expect(dev.issuer).toBe("http://localhost:3000");

    const prod = await receiptKeyringFromEnv({
      NODE_ENV: "production",
      BOTFARE_URL: "https://botfare.example",
    });
    expect(prod.active).toBeNull();
    expect(prod.problem).toMatch(/BOTFARE_RECEIPT_KEY_SEED/);

    const prodDevSeed = await receiptKeyringFromEnv({
      NODE_ENV: "production",
      BOTFARE_URL: "https://botfare.example",
      BOTFARE_RECEIPT_KEY_SEED: "short",
    });
    expect(prodDevSeed.active).toBeNull();

    const prodOk = await receiptKeyringFromEnv({
      NODE_ENV: "production",
      BOTFARE_URL: "https://botfare.example",
      BOTFARE_RECEIPT_KEY_SEED: SEED,
    });
    expect(prodOk.active?.kid).toBe((await deriveReceiptKey(SEED)).kid);
    expect(prodOk.development).toBe(false);
  });
});

function requirementsFor(payTo: string, extra: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: "prepaid",
    network: "paypal:sandbox",
    asset: "USD",
    amount: "3",
    payTo,
    maxTimeoutSeconds: 60,
    // The URL the publisher's server serves (what BotFare signs as `resource`).
    extra: { botfareResource: "https://brewlab.example/articles/grinders", ...extra },
  };
}

async function pay(
  ring: ReceiptKeyring | undefined,
  extra: Record<string, unknown> = {},
  ledgerKeyring: ReceiptKeyring | undefined = ring,
) {
  const publisher = await makePublisher(db);
  const agent = await makeAgent(db, { balanceCents: 100 });
  const facilitator = new PrepaidPayPalFacilitator({
    ledger: new PostgresPrepaidLedger(db, { keyring: ledgerKeyring }),
  });
  const client = new PrepaidPayPalClient({
    keyId: agent.key.id,
    privateJwk: agent.keys.privateJwk,
  });
  const requirements = requirementsFor(publisher.site.id, extra);
  const created = await client.createPaymentPayload(2, requirements);
  const payload: PaymentPayload = {
    x402Version: 2,
    // A forged claim: the agent's resource.url never reaches the receipt or the statement.
    resource: { url: "https://elsewhere.example/premium-report" },
    accepted: requirements,
    payload: created.payload,
  };
  const settled = await facilitator.settle(payload, requirements);
  return { publisher, agent, settled };
}

describe("payment statements", () => {
  it("are signed once at settle, returned in extra.botfareReceipt and verify with the JWKS", async () => {
    const ring = await testKeyring();
    const offer = { title: "Grinder guide", preview: "Burrs matter.", wordCount: 900 };
    const { publisher, agent, settled } = await pay(ring, {
      botfareSignal: "agent-header",
      botfareOffer: offer,
    });
    expect(settled.success).toBe(true);
    const jws = settled.extra?.[SETTLE_EXTRA_RECEIPT_KEY];
    expect(typeof jws).toBe("string");

    const verified = await verifyStatement(jws as string, receiptJwks(ring), {
      issuer: "https://botfare.example",
      kind: "payment",
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok || verified.statement.kind !== "payment") throw new Error("not verified");
    expect(verified.kid).toBe(ring.active?.kid);
    expect(verified.statement.sub).toBe(settled.transaction);
    expect(verified.statement.payment).toMatchObject({
      scheme: "prepaid",
      network: "paypal:sandbox",
      asset: "USD",
      amount: "3",
      amountMicros: 30_000,
      publisherMicros: 28_500,
      feeMicros: 1_500,
      payTo: publisher.site.id,
      siteOrigin: "https://brewlab.example",
      resource: "https://brewlab.example/articles/grinders",
      payer: agent.key.id,
      signal: "agent-header",
      offerDigest: await declaredOfferDigest(offer),
    });
    expect(verified.statement.payment.payerThumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Stored once: issuing again returns the same JWS, and the public lookup has it.
    expect(await issueReceiptStatement(db, settled.transaction, "payment", { keyring: ring })).toBe(
      jws,
    );
    const rows = await db
      .select()
      .from(schema.receiptStatements)
      .where(eq(schema.receiptStatements.receiptId, settled.transaction));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kid).toBe(ring.active?.kid);
    expect(await getReceiptStatements(db, settled.transaction)).toEqual({
      receiptId: settled.transaction,
      payment: jws,
      delivery: null,
      refund: null,
    });
  });

  it("do not verify against another key set or as another kind", async () => {
    const ring = await testKeyring();
    const { settled } = await pay(ring);
    const jws = settled.extra?.[SETTLE_EXTRA_RECEIPT_KEY] as string;
    const other = await receiptKeyringFromEnv({
      BOTFARE_RECEIPT_KEY_SEED: "a-completely-different-seed-0123456789",
    });
    expect(await verifyStatement(jws, receiptJwks(other))).toMatchObject({
      ok: false,
      error: "unknown_key",
    });
    expect(await verifyStatement(jws, receiptJwks(ring), { kind: "delivery" })).toMatchObject({
      ok: false,
    });
  });

  it("keep verifying after a key rotation (old key published as previous)", async () => {
    const ring = await testKeyring();
    const { settled } = await pay(ring);
    const jws = settled.extra?.[SETTLE_EXTRA_RECEIPT_KEY] as string;
    const rotated = await receiptKeyringFromEnv({
      BOTFARE_RECEIPT_KEY_SEED: "the-next-receipt-seed-0123456789-abcdef",
      BOTFARE_RECEIPT_KEY_SEED_PREVIOUS: SEED,
      BOTFARE_URL: "https://botfare.example",
    });
    expect(rotated.active?.kid).not.toBe(ring.active?.kid);
    expect((await verifyStatement(jws, receiptJwks(rotated))).ok).toBe(true);
    // Rotation never re-signs history: the stored statement is returned as it was.
    expect(
      await issueReceiptStatement(db, settled.transaction, "payment", { keyring: rotated }),
    ).toBe(jws);
  });

  it("are null in production without a seed, but the payment still settles; issued lazily later", async () => {
    const ring = await testKeyring();
    const disabled = await receiptKeyringFromEnv({
      NODE_ENV: "production",
      BOTFARE_URL: "https://botfare.example",
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { settled } = await pay(disabled);
    errors.mockRestore();
    expect(settled.success).toBe(true);
    expect(settled.transaction).toMatch(/^rcpt_/);
    expect(settled.extra).toBeUndefined();
    expect(
      await getReceiptStatements(db, settled.transaction, { keyring: disabled }),
    ).toMatchObject({ payment: null });

    // Once a seed is configured, the statements endpoint issues the missing statement on read.
    const later = await getReceiptStatements(db, settled.transaction, {
      keyring: ring,
      issueMissing: true,
    });
    expect(later?.payment).toBeTruthy();
    expect((await verifyStatement(later?.payment as string, receiptJwks(ring))).ok).toBe(true);
  });

  it("returns null for unknown receipts", async () => {
    const ring = await testKeyring();
    expect(await getReceiptStatements(db, "rcpt_missing", { issueMissing: true })).toBeNull();
    expect(
      await issueReceiptStatement(db, "rcpt_missing", "payment", { keyring: ring }),
    ).toBeNull();
  });
});

describe("delivery and refund statements", () => {
  it("sign the delivery at the first attestation only", async () => {
    const ring = await testKeyring();
    const { publisher, settled } = await pay(ring);
    const receiptId = settled.transaction;
    expect(await issueReceiptStatement(db, receiptId, "delivery", { keyring: ring })).toBeNull();

    const attestation = {
      contentDigest: "sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:",
      contentLength: 1234,
      contentType: "text/html; charset=utf-8",
      status: 200,
    };
    const first = await attestReceipt(db, { siteId: publisher.site.id, receiptId, attestation });
    expect(first).toMatchObject({ ok: true, alreadyAttested: false });
    const statements = await getReceiptStatements(db, receiptId);
    expect(statements?.delivery).toBeTruthy();
    const verified = await verifyStatement(statements?.delivery as string, receiptJwks(ring), {
      kind: "delivery",
    });
    expect(verified.ok && verified.statement).toMatchObject({
      sub: receiptId,
      delivery: {
        contentDigest: attestation.contentDigest,
        contentLength: 1234,
        contentType: "text/html",
        status: 200,
      },
    });

    const again = await attestReceipt(db, { siteId: publisher.site.id, receiptId, attestation });
    expect(again).toMatchObject({ ok: true, alreadyAttested: true });
    expect((await getReceiptStatements(db, receiptId))?.delivery).toBe(statements?.delivery);
  });

  it("sign a publisher refund once", async () => {
    const ring = await testKeyring();
    const { publisher, settled } = await pay(ring);
    const receiptId = settled.transaction;
    const refunded = await refundReceipt(db, { receiptId, siteId: publisher.site.id });
    expect(refunded.ok).toBe(true);
    const refund = (await getReceiptStatements(db, receiptId))?.refund;
    expect(refund).toBeTruthy();
    const verified = await verifyStatement(refund as string, receiptJwks(ring), { kind: "refund" });
    expect(verified.ok && verified.statement).toMatchObject({
      sub: receiptId,
      refund: { refundedMicros: 30_000, via: "publisher", disputeId: null },
    });

    await refundReceipt(db, { receiptId, siteId: publisher.site.id });
    const rows = await db
      .select()
      .from(schema.receiptStatements)
      .where(eq(schema.receiptStatements.receiptId, receiptId));
    expect(rows.map((r) => r.kind).sort()).toEqual(["payment", "refund"]);
    expect((await getReceiptStatements(db, receiptId))?.refund).toBe(refund);
  });

  async function disputed() {
    const ring = await testKeyring();
    const { publisher, agent, settled } = await pay(ring, {
      botfareOffer: { title: "Grinder guide", preview: "Burrs matter." },
    });
    const receiptId = settled.transaction;
    const bytes = new TextEncoder().encode("Subscribe to keep reading.");
    const digest = `sha-256=:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("base64")}:`;
    await attestReceipt(db, {
      siteId: publisher.site.id,
      receiptId,
      attestation: {
        contentDigest: digest,
        contentLength: bytes.length,
        contentType: "text/plain",
        status: 200,
      },
    });
    const opened = await openDispute(db, {
      agentKeyId: agent.key.id,
      request: {
        receiptId,
        reason: "stub_or_paywall",
        contentBase64: Buffer.from(bytes).toString("base64"),
      },
    });
    if (!opened.ok) throw new Error(`dispute not opened: ${opened.reason} ${opened.message}`);
    return { ring, publisher, receiptId, disputeId: opened.dispute.id };
  }

  it("sign a Fare Court refund (applyVerdict) with via dispute and the dispute ID", async () => {
    const { ring, receiptId, disputeId } = await disputed();
    const decided = await applyVerdict(db, {
      disputeId,
      verdict: {
        decision: "refund",
        category: "stub_or_paywall",
        confidence: 0.95,
        rationale: "A paywall stub.",
      },
    });
    expect(decided).toMatchObject({ ok: true, changed: true });
    const refund = (await getReceiptStatements(db, receiptId))?.refund;
    const verified = await verifyStatement(refund as string, receiptJwks(ring), { kind: "refund" });
    expect(verified.ok && verified.statement).toMatchObject({
      refund: { via: "dispute", disputeId },
    });
  });

  it("sign a refund the publisher accepts (publisherDecide)", async () => {
    const { ring, publisher, receiptId, disputeId } = await disputed();
    const decided = await publisherDecide(db, {
      disputeId,
      publisherUserId: publisher.owner.id,
      accept: true,
    });
    expect(decided).toMatchObject({ ok: true, changed: true });
    const refund = (await getReceiptStatements(db, receiptId))?.refund;
    const verified = await verifyStatement(refund as string, receiptJwks(ring), { kind: "refund" });
    expect(verified.ok && verified.statement).toMatchObject({
      refund: { via: "dispute", disputeId },
    });
    expect(decodeStatement(refund as string)?.kind).toBe("refund");
  });
});
