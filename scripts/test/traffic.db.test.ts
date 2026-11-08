import {
  checkLedgerInvariants,
  createSite,
  listReceipts,
  walletBalanceMicros,
} from "@botfare/core";
import { afterAll, describe, expect, it } from "vitest";
import { freePaths, pricing } from "../../apps/demo/src/pricing";
import { makeUser, openTestDb } from "../../packages/core/test/helpers";
import { nonceFor, planTraffic, runTraffic } from "../lib/traffic";

const { db, close } = openTestDb();
afterAll(() => close());

const DAY_MS = 24 * 3600 * 1000;

async function demoSetup() {
  const owner = await makeUser(db, "traffic-owner");
  const publisher = await makeUser(db, "traffic-publisher");
  const { site } = await createSite(db, {
    ownerUserId: publisher.id,
    name: "Crema Notes",
    origin: "https://crema.example",
    pricing,
    freePaths,
  });
  return { owner, site };
}

describe("seed:traffic", () => {
  it("plans different traffic on different days, so the anchor has to be fixed", () => {
    const friday = new Date("2026-11-06T15:00:00Z");
    const saturday = new Date(friday.getTime() + DAY_MS);
    const a = planTraffic("demo", friday);
    const b = planTraffic("demo", saturday);
    const differs = a.some(
      (request, i) => b[i]?.key.name !== request.key.name || b[i]?.path !== request.path,
    );
    expect(differs || a.length !== b.length).toBe(true);
  });

  it("moves no money when rerun with the same run key on a later day", async () => {
    const { owner, site } = await demoSetup();
    const first = new Date("2026-11-06T15:00:00Z");
    const run1 = await runTraffic(db, { runKey: "demo", ownerUserId: owner.id, site, now: first });
    expect(run1.funded).toBe(true);
    expect(run1.alreadyPaid).toBe(0);
    expect(run1.refunds).toBe(2);
    const balance = await walletBalanceMicros(db, owner.id);
    const receipts = (await listReceipts(db, { ownerUserId: owner.id, limit: 1000 })).length;
    expect(receipts).toBeGreaterThan(100);

    for (const later of [1, 3]) {
      const now = new Date(first.getTime() + later * DAY_MS);
      const rerun = await runTraffic(db, { runKey: "demo", ownerUserId: owner.id, site, now });
      expect(rerun.anchor).toEqual(first);
      expect(rerun.funded).toBe(false);
      expect(rerun.paid.size).toBe(0);
      expect(rerun.refunds).toBe(0);
      expect(rerun.plan.map((r) => nonceFor("demo", r.index))).toEqual(
        run1.plan.map((r) => nonceFor("demo", r.index)),
      );
      expect(rerun.plan.map((r) => [r.key.name, r.path, r.at.getTime()])).toEqual(
        run1.plan.map((r) => [r.key.name, r.path, r.at.getTime()]),
      );
    }
    expect(await walletBalanceMicros(db, owner.id)).toBe(balance);
    expect((await listReceipts(db, { ownerUserId: owner.id, limit: 1000 })).length).toBe(receipts);
    expect((await checkLedgerInvariants(db)).ok).toBe(true);
  });
});
