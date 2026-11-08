/**
 * `pnpm seed:traffic`: realistic demo traffic so the wallet, publisher and analytics dashboards
 * are not empty. Run `pnpm seed` first. Safe to run again.
 *
 * - issues (or reuses, by name) three more agent keys for the agent owner persona:
 *   "Research agent", "Price watcher" and "Newsletter bot", each with its own budget;
 * - plans about 150 paid requests over the last 14 days across the Crema Notes articles and the
 *   brew ratio API (a fixed pseudo-random plan per run key, busier on weekdays and growing);
 * - tops the agent owner's wallet up with a `seed` posting that covers the plan, once per run key;
 * - settles each request through PostgresPrepaidLedger with a clock set to the request's time,
 *   so every per-request max, daily cap, allowed-site and balance rule applies as it would live;
 * - refunds two receipts, as a publisher would after a duplicate fetch;
 * - checks the ledger invariants at the end.
 *
 * Idempotent per run key: nonces, the wallet top-up and the refunds are all keyed by it, and the
 * plan's dates are anchored to the first run (stored with the funding), so a second run with the
 * same key moves no money, on the same day or any later one. `--run-key <key>` (default "demo")
 * makes a new batch of traffic. The plan itself lives in scripts/lib/traffic.ts.
 */
import { parseArgs } from "node:util";
import { DEMO_PERSONAS } from "@botfare/contracts";
import {
  checkLedgerInvariants,
  createDb,
  getUserByEmail,
  listSites,
  walletBalanceMicros,
} from "@botfare/core";
import { SITE_NAME } from "../apps/demo/src/pricing";
import { loadRootEnv, requireEnv } from "./lib/env-file";
import { runTraffic } from "./lib/traffic";

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

async function main(): Promise<void> {
  const { values: flags } = parseArgs({
    options: { "run-key": { type: "string", default: "demo" } },
  });
  const runKey = flags["run-key"].trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(runKey)) {
    throw new Error("--run-key may use letters, digits, - and _ (at most 40)");
  }
  loadRootEnv();
  const { db, close } = createDb(requireEnv("DATABASE_URL"), { max: 2 });
  try {
    const owner = await getUserByEmail(db, DEMO_PERSONAS.agentOwner.email);
    const publisher = await getUserByEmail(db, DEMO_PERSONAS.publisher.email);
    if (!owner || !publisher) throw new Error("Demo personas are missing: run pnpm seed first");
    const site = (await listSites(db, publisher.id)).find((s) => s.name === SITE_NAME);
    if (!site) throw new Error(`${SITE_NAME} is not registered: run pnpm seed first`);

    const run = await runTraffic(db, { runKey, ownerUserId: owner.id, site });
    for (const { name, key, created } of run.keys) {
      console.log(`Agent key    ${key.id} ${name} ${created ? "issued" : "reused"}`);
    }
    console.log(
      `Wallet       ${run.funded ? `topped up ${usd(run.plannedCents * 10_000)} (seed)` : "already funded for this run"}`,
    );
    const first = run.plan[0]?.at.toISOString().slice(0, 10);
    const last = run.plan.at(-1)?.at.toISOString().slice(0, 10);
    console.log(
      `Traffic      ${run.plan.length} requests planned, ${first} to ${last} (anchored ${run.anchor.toISOString()})`,
    );
    for (const [name, entry] of run.paid) {
      console.log(`             ${name}: ${entry.paid} paid, ${usd(entry.micros)}`);
    }
    if (run.alreadyPaid > 0)
      console.log(`             ${run.alreadyPaid} already settled by an earlier run`);
    for (const [reason, count] of run.refused) {
      console.log(`             ${count} refused by the ledger (${reason})`);
    }
    if (run.refunds > 0)
      console.log(`Refunds      ${run.refunds} receipts refunded by the publisher`);

    const balance = await walletBalanceMicros(db, owner.id);
    console.log(`Wallet       balance ${usd(balance)}`);
    const report = await checkLedgerInvariants(db);
    if (!report.ok) {
      throw new Error(
        `Ledger invariants broken: total ${report.totalMicros}, ${report.balanceMismatches.length} mismatches, ${report.unbalancedTransactions.length} unbalanced`,
      );
    }
    console.log("Ledger       sums to zero; cached balances match entries");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error("FAIL seed:traffic:", err instanceof Error ? err.message : err);
  process.exit(1);
});
