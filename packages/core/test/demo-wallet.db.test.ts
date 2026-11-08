import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  DEMO_WALLET_FLOOR_CENTS,
  ensureDemoWalletFloor,
  PostgresPrepaidLedger,
  updateAgentKeyLimits,
  walletBalanceMicros,
} from "../src";
import {
  chargeRequest,
  expectLedgerHealthy,
  makeAgent,
  makePublisher,
  openTestDb,
} from "./helpers";

const { db, close } = openTestDb();
const ledger = new PostgresPrepaidLedger(db);
afterEach(() => expectLedgerHealthy(db));
afterAll(close);

describe("ensureDemoWalletFloor", () => {
  it("tops the shared agent wallet back up to the floor, once per change, even concurrently", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: DEMO_WALLET_FLOOR_CENTS });
    const floor = DEMO_WALLET_FLOOR_CENTS * 10_000;
    expect(await ensureDemoWalletFloor(db, { userId: agent.owner.id })).toEqual({ addedCents: 0 });

    expect((await ledger.charge(chargeRequest(agent.key.id, publisher.site.id))).ok).toBe(true);
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(floor - 30_000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureDemoWalletFloor(db, { userId: agent.owner.id })),
    );
    expect(results.reduce((sum, r) => sum + r.addedCents, 0)).toBe(3);
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(floor);

    // The next charge allows the next top-up, back to the same balance.
    expect((await ledger.charge(chargeRequest(agent.key.id, publisher.site.id))).ok).toBe(true);
    expect(await ensureDemoWalletFloor(db, { userId: agent.owner.id })).toEqual({ addedCents: 3 });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(floor);
  });

  it("starts an empty wallet at the floor", async () => {
    const agent = await makeAgent(db);
    expect(await ensureDemoWalletFloor(db, { userId: agent.owner.id, floorCents: 250 })).toEqual({
      addedCents: 250,
    });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(2_500_000);
  });
});

describe("updateAgentKeyLimits", () => {
  it("raises a key's daily cap in place; the facilitator applies it on the next charge", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, {
      balanceCents: 100,
      perRequestMaxCents: 10,
      dailyCapCents: 3,
    });
    expect((await ledger.charge(chargeRequest(agent.key.id, publisher.site.id))).ok).toBe(true);
    const over = chargeRequest(agent.key.id, publisher.site.id);
    expect(await ledger.check(over)).toMatchObject({ reason: "invalid_prepaid_over_daily_cap" });

    const updated = await updateAgentKeyLimits(db, {
      keyId: agent.key.id,
      perRequestMaxCents: 10,
      dailyCapCents: 1_000,
    });
    expect(updated).toMatchObject({ id: agent.key.id, dailyCapCents: 1_000, status: "active" });
    expect((await ledger.charge(over)).ok).toBe(true);
    expect(
      await updateAgentKeyLimits(db, {
        keyId: "ak_missing",
        perRequestMaxCents: 1,
        dailyCapCents: 1,
      }),
    ).toBeNull();
  });
});
