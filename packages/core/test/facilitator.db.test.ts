import { PrepaidPayPalClient, PrepaidPayPalFacilitator } from "@botfare/x402-paypal";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  earningsBalanceMicros,
  getReceipt,
  PostgresPrepaidLedger,
  walletBalanceMicros,
} from "../src";
import { expectLedgerHealthy, makeAgent, makePublisher, openTestDb } from "./helpers";

const { db, close } = openTestDb();
afterEach(() => expectLedgerHealthy(db));
afterAll(close);

describe("x402 plug-in on the Postgres ledger", () => {
  it("verifies without moving money, settles once, and refuses the replay", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 100 });
    const facilitator = new PrepaidPayPalFacilitator({ ledger: new PostgresPrepaidLedger(db) });
    const client = new PrepaidPayPalClient({
      keyId: agent.key.id,
      privateJwk: agent.keys.privateJwk,
    });
    const requirements: PaymentRequirements = {
      scheme: "prepaid",
      network: "paypal:sandbox",
      asset: "USD",
      amount: "3",
      payTo: publisher.site.id,
      maxTimeoutSeconds: 60,
      // The publisher's server names the URL it serves; the agent's resource.url is ignored.
      extra: { botfareResource: "https://brewlab.example/articles/grinders" },
    };
    const created = await client.createPaymentPayload(2, requirements);
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: "https://elsewhere.example/premium-report" },
      accepted: requirements,
      payload: created.payload,
    };

    expect(await facilitator.verify(payload, requirements)).toEqual({
      isValid: true,
      payer: agent.key.id,
    });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(1_000_000);

    const settled = await facilitator.settle(payload, requirements);
    expect(settled).toMatchObject({
      success: true,
      payer: agent.key.id,
      network: "paypal:sandbox",
      amount: "3",
    });
    expect(settled.transaction).toMatch(/^rcpt_/);
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(970_000);
    expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(28_500);
    expect(await getReceipt(db, settled.transaction)).toMatchObject({
      resourceUrl: "https://brewlab.example/articles/grinders",
      status: "settled",
    });

    const replay = await facilitator.settle(payload, requirements);
    expect(replay).toMatchObject({
      success: false,
      errorReason: "invalid_prepaid_nonce_used",
      extra: { originalTransaction: settled.transaction },
    });
    expect((await facilitator.verify(payload, requirements)).invalidReason).toBe(
      "invalid_prepaid_nonce_used",
    );
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(970_000);
  });

  it("refuses a payment the wallet cannot cover", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 2 });
    const facilitator = new PrepaidPayPalFacilitator({ ledger: new PostgresPrepaidLedger(db) });
    const client = new PrepaidPayPalClient({
      keyId: agent.key.id,
      privateJwk: agent.keys.privateJwk,
    });
    const requirements: PaymentRequirements = {
      scheme: "prepaid",
      network: "paypal:sandbox",
      asset: "USD",
      amount: "3",
      payTo: publisher.site.id,
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const created = await client.createPaymentPayload(2, requirements);
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: created.payload,
    };
    expect((await facilitator.verify(payload, requirements)).invalidReason).toBe(
      "insufficient_funds",
    );
    expect((await facilitator.settle(payload, requirements)).errorReason).toBe(
      "insufficient_funds",
    );
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(20_000);
  });
});
