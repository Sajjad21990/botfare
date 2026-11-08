import type { PaymentPayload } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  generateAgentKeyPair,
  PrepaidPayPalClient,
  RESOURCE_EXTRA_KEY,
  serverResourceUrl,
  signAuthorization,
} from "../src";
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

  it("hands the requirements' extra (the detection signal) to the ledger on settle", async () => {
    const { facilitator, pay, ledger } = await setup();
    const seen: Array<Record<string, unknown> | undefined> = [];
    const charge = ledger.charge.bind(ledger);
    ledger.charge = (request) => {
      seen.push(request.extra);
      return charge(request);
    };
    const withSignal = { ...requirements, extra: { botfareSignal: "signed-agent" } };
    const result = await facilitator.settle(await pay(), withSignal);
    expect(result.success).toBe(true);
    expect(seen).toEqual([{ botfareSignal: "signed-agent" }]);
  });

  it("records the server's resource URL from extra, never the agent's payload.resource", async () => {
    const { facilitator, pay, ledger } = await setup();
    const seen: Array<string | undefined> = [];
    const charge = ledger.charge.bind(ledger);
    ledger.charge = (request) => {
      seen.push(request.resourceUrl);
      return charge(request);
    };
    const served = "https://demo.example/api/brew-ratio";
    const withResource = { ...requirements, extra: { [RESOURCE_EXTRA_KEY]: served } };
    // The agent pays the cheap endpoint but claims a premium page (and, next, omits the field).
    const forged = {
      ...(await pay(withResource)),
      resource: { url: "https://demo.example/premium" },
    };
    expect((await facilitator.settle(forged, withResource)).success).toBe(true);
    const { resource: _omitted, ...bare } = await pay(withResource);
    expect((await facilitator.settle(bare as PaymentPayload, withResource)).success).toBe(true);
    // Without a server-declared URL nothing is recorded, whatever the agent sent.
    expect((await facilitator.settle(await pay(), requirements)).success).toBe(true);
    expect(seen).toEqual([served, served, undefined]);
  });

  it("accepts only http(s) resource URLs of sane length", () => {
    expect(serverResourceUrl({ [RESOURCE_EXTRA_KEY]: "https://a.example/x?y=1" })).toBe(
      "https://a.example/x?y=1",
    );
    expect(serverResourceUrl({ [RESOURCE_EXTRA_KEY]: "javascript:alert(1)" })).toBeUndefined();
    expect(serverResourceUrl({ [RESOURCE_EXTRA_KEY]: "/relative" })).toBeUndefined();
    expect(serverResourceUrl({ [RESOURCE_EXTRA_KEY]: 42 })).toBeUndefined();
    expect(
      serverResourceUrl({ [RESOURCE_EXTRA_KEY]: `https://a.example/${"x".repeat(2100)}` }),
    ).toBeUndefined();
    expect(serverResourceUrl(undefined)).toBeUndefined();
  });

  it("rejects a replayed payment but points at the original receipt", async () => {
    const { facilitator, pay, ledger } = await setup();
    const payload = await pay();
    const first = await facilitator.settle(payload, requirements);
    expect(first.success).toBe(true);
    const replay = await facilitator.settle(payload, requirements);
    expect(replay.success).toBe(false);
    expect(replay.errorReason).toBe("invalid_prepaid_nonce_used");
    expect(replay.extra).toEqual({ originalTransaction: first.transaction });
    expect(ledger.balanceMicros("wallet:owner")).toBe(970_000);
  });

  it("rejects an authorization dated in the future (fast agent clock)", async () => {
    const { facilitator, keys, ledger } = await setup();
    const fast = new PrepaidPayPalClient({
      keyId: "ak_test",
      privateJwk: keys.privateJwk,
      now: () => new Date(Date.now() + 10 * 60_000),
    });
    const result = await fast.createPaymentPayload(2, requirements);
    const payload = { x402Version: 2, accepted: requirements, payload: result.payload };
    expect((await facilitator.verify(payload, requirements)).invalidReason).toBe(
      "invalid_prepaid_authorization_expired",
    );
    expect((await facilitator.settle(payload, requirements)).success).toBe(false);
    expect(ledger.balanceMicros("wallet:owner")).toBe(1_000_000);
  });

  it("caps the lifetime at 60 s even when maxTimeoutSeconds is missing", async () => {
    const { facilitator, keys } = await setup();
    const now = Math.floor(Date.now() / 1000);
    const token = await signAuthorization(
      {
        scheme: "prepaid",
        network: "paypal:sandbox",
        asset: "USD",
        amount: "3",
        payTo: "site_demo",
        nonce: crypto.randomUUID(),
        iat: now,
        exp: now + 365 * 24 * 3600,
      },
      "ak_test",
      keys.privateJwk,
    );
    const loose = { ...requirements, maxTimeoutSeconds: undefined as unknown as number };
    const verdict = await facilitator.verify(
      { x402Version: 2, accepted: loose, payload: { authorization: token } },
      loose,
    );
    expect(verdict.isValid).toBe(false);
    expect(verdict.invalidReason).toBe("invalid_prepaid_authorization_mismatch");
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
