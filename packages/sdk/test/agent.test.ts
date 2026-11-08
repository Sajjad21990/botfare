import { AGENT_HEADER } from "@botfare/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BotFareAgentKeyError,
  BotFareSpendLimitError,
  createBotFareAgent,
  readReceipt,
  type WireEvent,
} from "../src";
import { ARTICLE_PREVIEW, KEY_ID, SITE_ID, startStack } from "./harness";

let stack: Awaited<ReturnType<typeof startStack>>;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack.stop();
});

describe("createBotFareAgent", () => {
  it("getOffer returns the price and preview without moving money", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey });
    const before = stack.wallet();
    const url = `${stack.siteUrl}/articles/burr-basics`;

    const offer = await agent.getOffer(url);

    expect(agent.keyId).toBe(KEY_ID);
    expect(offer).toMatchObject({
      url,
      priceCents: 3,
      priceUsd: "$0.03",
      payTo: SITE_ID,
      description: "Burr grinders, explained",
      preview: ARTICLE_PREVIEW,
    });
    expect(offer?.requirements).toMatchObject({ scheme: "prepaid", network: "paypal:sandbox" });
    expect(offer?.paymentRequired.x402Version).toBe(2);
    expect(stack.wallet()).toBe(before);
    expect(stack.ledger.receipts).toHaveLength(0);
  });

  it("getOffer returns null for a page that does not ask for payment", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey });
    expect(await agent.getOffer(`${stack.siteUrl}/free`)).toBeNull();
  });

  it("fetch pays within the cap and returns the content with a receipt", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey });
    const before = stack.wallet();

    const result = await agent.fetch(`${stack.siteUrl}/articles/burr-basics`);

    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toContain("<h1>Burr grinders");
    expect(result.paid).toBe(true);
    expect(result.receipt).toMatchObject({
      success: true,
      network: "paypal:sandbox",
      payer: KEY_ID,
    });
    expect(result.receipt?.transaction).toMatch(/^rcpt_/);
    expect(readReceipt(result.response)).toEqual(result.receipt);
    expect(result.offer?.priceCents).toBe(3);
    expect(before - stack.wallet()).toBe(30_000);
    expect(stack.ledger.totalMicros()).toBe(0);
  });

  it("fetch of a free page returns paid=false and no receipt", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey });
    const result = await agent.fetch(`${stack.siteUrl}/free`);
    expect(result).toMatchObject({ paid: false, receipt: null, offer: null });
    expect(await result.response.json()).toEqual({ free: true });
  });

  it("sends the agent header on getOffer and on both legs of a paid fetch", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey });
    const from = stack.seen.length;
    await agent.getOffer(`${stack.siteUrl}/articles/burr-basics`);
    await agent.fetch(`${stack.siteUrl}/articles/burr-basics`, {
      headers: { accept: "text/html" },
    });
    const requests = stack.seen.slice(from);
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.agentHeader !== undefined)).toBe(true);
    expect(requests.map((r) => r.paymentSignature)).toEqual([false, false, true]);
    expect(AGENT_HEADER).toBe("x-botfare-agent");
  });

  it("refuses an over-cap price without signing or moving money", async () => {
    const events: WireEvent[] = [];
    const agent = createBotFareAgent({
      agentKey: stack.agentKey,
      onWire: (event) => events.push(event),
    });
    const before = stack.wallet();
    const receipts = stack.ledger.receipts.length;
    const from = stack.seen.length;
    const url = `${stack.siteUrl}/reports/deep-dive`;

    const error = await agent.fetch(url).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BotFareSpendLimitError);
    const limit = error as BotFareSpendLimitError;
    expect(limit.offer.priceCents).toBe(25);
    expect(limit.maxPerRequestCents).toBe(10);
    expect(limit.message).toContain("$0.25");
    expect(stack.seen.slice(from).map((r) => r.paymentSignature)).toEqual([false]);
    expect(events.map((e) => e.stage)).toEqual(["payment-required"]);
    expect(stack.wallet()).toBe(before);
    expect(stack.ledger.receipts).toHaveLength(receipts);
  });

  it("pays a higher price when maxPerRequestUsd allows it", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, maxPerRequestUsd: 0.25 });
    const result = await agent.fetch(`${stack.siteUrl}/reports/deep-dive`);
    expect(result.paid).toBe(true);
    expect(agent.maxPerRequestCents).toBe(25);
  });

  it("onWire reports payment-required, payment-signature and payment-response in order", async () => {
    const events: WireEvent[] = [];
    const agent = createBotFareAgent({
      agentKey: stack.agentKey,
      onWire: (event) => events.push(event),
    });
    const url = `${stack.siteUrl}/articles/burr-basics`;

    const result = await agent.fetch(url);

    expect(events.map((e) => e.stage)).toEqual([
      "payment-required",
      "payment-signature",
      "payment-response",
    ]);
    const [required, signature, response] = events;
    expect(required?.url).toBe(url);
    expect(required?.stage === "payment-required" && required.decoded.accepts[0]?.amount).toBe("3");
    if (signature?.stage !== "payment-signature") throw new Error("expected a signature event");
    expect(signature.header.length).toBeGreaterThan(0);
    expect(signature.decoded.accepted).toMatchObject({ amount: "3", payTo: SITE_ID });
    expect(signature.authorizationClaims).toMatchObject({
      scheme: "prepaid",
      network: "paypal:sandbox",
      asset: "USD",
      amount: "3",
      payTo: SITE_ID,
    });
    expect(signature.authorizationClaims.nonce.length).toBeGreaterThanOrEqual(16);
    expect(
      signature.authorizationClaims.exp - signature.authorizationClaims.iat,
    ).toBeLessThanOrEqual(60);
    if (response?.stage !== "payment-response") throw new Error("expected a response event");
    expect(response.decoded).toEqual(result.receipt);
  });

  it("returns the publisher's refusal reason when the wallet cannot pay", async () => {
    const drained = await startStack();
    try {
      drained.ledger.balances.set("wallet:owner_sdk", 10_000); // 1 cent left
      drained.ledger.balances.set("paypal:clearing", -10_000);
      const agent = createBotFareAgent({ agentKey: drained.agentKey });
      const result = await agent.fetch(`${drained.siteUrl}/articles/burr-basics`);
      expect(result.response.status).toBe(402);
      expect(result.paid).toBe(false);
      expect(result.failureReason).toBe("insufficient_funds");
      expect(drained.wallet()).toBe(10_000);
    } finally {
      await drained.stop();
    }
  });

  it("fails fast on an invalid agent key without echoing it", () => {
    expect(() => createBotFareAgent({ agentKey: "sk_live_nope" })).toThrow(BotFareAgentKeyError);
    const garbage = `bfk_${Buffer.from('{"v":1,"keyId":"secretish"}').toString("base64url")}`;
    let error: unknown;
    try {
      createBotFareAgent({ agentKey: garbage });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(BotFareAgentKeyError);
    expect((error as Error).message).not.toContain("secretish");
    expect(() => createBotFareAgent({ agentKey: stack.agentKey, maxPerRequestUsd: 0 })).toThrow(
      RangeError,
    );
  });
});
