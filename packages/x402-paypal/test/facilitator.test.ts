import { describe, expect, it } from "vitest";
import { generateAgentKeyPair, PrepaidPayPalClient } from "../src";
import { requirements, setup } from "./helpers";

describe("PrepaidPayPalFacilitator", () => {
  it("verifies a valid payment without moving money", async () => {
    const { facilitator, pay, ledger } = await setup();
    const result = await facilitator.verify(await pay(), requirements);
    expect(result).toEqual({ isValid: true, payer: "ak_test" });
    expect(ledger.balanceMicros("wallet:owner")).toBe(1_000_000);
  });

  it("settles: debits the wallet, credits publisher 95% and BotFare 5%", async () => {
    const { facilitator, pay, ledger } = await setup();
    const result = await facilitator.settle(await pay(), requirements);
    expect(result.success).toBe(true);
    expect(result.transaction).toMatch(/^rcpt_/);
    expect(result.amount).toBe("3");
    expect(ledger.balanceMicros("wallet:owner")).toBe(970_000);
    expect(ledger.balanceMicros("earnings:site_demo")).toBe(28_500);
    expect(ledger.balanceMicros("platform:fees")).toBe(1_500);
    expect(ledger.totalMicros()).toBe(0);
  });

  it("rejects a replayed payment", async () => {
    const { facilitator, pay } = await setup();
    const payload = await pay();
    expect((await facilitator.settle(payload, requirements)).success).toBe(true);
    const replay = await facilitator.settle(payload, requirements);
    expect(replay.success).toBe(false);
    expect(replay.errorReason).toBe("invalid_prepaid_nonce_used");
  });

  it("rejects a payment signed for a different amount", async () => {
    const { facilitator, pay } = await setup();
    const payload = await pay({ ...requirements, amount: "1" });
    const result = await facilitator.verify({ ...payload, accepted: requirements }, requirements);
    expect(result.invalidReason).toBe("invalid_prepaid_authorization_mismatch");
  });

  it("rejects a payment signed for a different site", async () => {
    const { facilitator, pay } = await setup();
    const payload = await pay({ ...requirements, payTo: "site_other" });
    const result = await facilitator.verify({ ...payload, accepted: requirements }, requirements);
    expect(result.invalidReason).toBe("invalid_prepaid_authorization_mismatch");
  });

  it("rejects a signature from an unregistered key", async () => {
    const { facilitator } = await setup();
    const stranger = await generateAgentKeyPair();
    const client = new PrepaidPayPalClient({ keyId: "ak_test", privateJwk: stranger.privateJwk });
    const result = await client.createPaymentPayload(2, requirements);
    const verdict = await facilitator.verify(
      { x402Version: 2, accepted: requirements, payload: result.payload },
      requirements,
    );
    expect(verdict.invalidReason).toBe("invalid_prepaid_signature");
  });

  it("rejects an expired authorization", async () => {
    const { facilitator, keys, ledger } = await setup();
    const old = new PrepaidPayPalClient({
      keyId: "ak_test",
      privateJwk: keys.privateJwk,
      now: () => new Date(Date.now() - 5 * 60_000),
    });
    const result = await old.createPaymentPayload(2, requirements);
    const verdict = await facilitator.settle(
      { x402Version: 2, accepted: requirements, payload: result.payload },
      requirements,
    );
    expect(verdict.errorReason).toBe("invalid_prepaid_authorization_expired");
    expect(ledger.balanceMicros("wallet:owner")).toBe(1_000_000);
  });

  it("enforces balance, per-request max, daily cap and allowed sites", async () => {
    const poor = await setup({ balanceCents: 2 });
    expect((await poor.facilitator.verify(await poor.pay(), requirements)).invalidReason).toBe(
      "insufficient_funds",
    );

    const capped = await setup({ perRequestMaxCents: 2 });
    expect((await capped.facilitator.verify(await capped.pay(), requirements)).invalidReason).toBe(
      "invalid_prepaid_over_per_request_max",
    );

    const daily = await setup({ dailyCapCents: 5 });
    expect((await daily.facilitator.settle(await daily.pay(), requirements)).success).toBe(true);
    expect((await daily.facilitator.settle(await daily.pay(), requirements)).errorReason).toBe(
      "invalid_prepaid_over_daily_cap",
    );

    const fenced = await setup({ allowedPayTo: ["site_other"] });
    expect((await fenced.facilitator.verify(await fenced.pay(), requirements)).invalidReason).toBe(
      "invalid_prepaid_site_not_allowed",
    );
  });

  it("rejects malformed payloads and foreign schemes", async () => {
    const { facilitator, pay } = await setup();
    const payload = await pay();
    expect(
      (await facilitator.verify({ ...payload, payload: {} }, requirements)).invalidReason,
    ).toBe("invalid_payload");
    expect(
      (await facilitator.verify(payload, { ...requirements, scheme: "exact" })).invalidReason,
    ).toBe("invalid_scheme");
    expect(
      (await facilitator.verify(payload, { ...requirements, network: "eip155:8453" }))
        .invalidReason,
    ).toBe("invalid_network");
  });
});
