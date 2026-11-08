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
 * Idempotent per run key: nonces, the wallet top-up and the refunds are all keyed by it, so a
 * second run with the same key moves no money. `--run-key <key>` (default "demo") makes a new
 * batch of traffic.
 */
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { DEMO_PERSONAS } from "@botfare/contracts";
import {
  type AgentKey,
  checkLedgerInvariants,
  createAgentKey,
  createDb,
  type Db,
  getUserByEmail,
  listAgentKeys,
  listSites,
  PostgresPrepaidLedger,
  refundReceipt,
  seedWallet,
  walletBalanceMicros,
} from "@botfare/core";
import { ErrorReason, generateAgentKeyPair, PAYPAL_SANDBOX } from "@botfare/x402-paypal";
import { priceCentsFor, SITE_NAME } from "../apps/demo/src/pricing";
import { loadRootEnv, requireEnv } from "./lib/env-file";

const DAYS = 14;
/** Part of every nonce and funding key: bump it when the plan changes so runs never overlap. */
const PLAN_VERSION = "v2";
const DAY_MS = 24 * 3600 * 1000;

interface KeyPlan {
  name: string;
  perRequestMaxCents: number;
  dailyCapCents: number;
  /** Restrict the key to Crema Notes (true) or let it pay any site (false). */
  cremaOnly: boolean;
  /** Share of the day's requests. */
  weight: number;
  /** Picks the path for one request. */
  pick: (random: () => number) => string;
}

const ARTICLES = ["burr-basics", "grinders-under-200", "latte-art-hearts", "dialing-in-espresso"];
const BREW_METHODS = ["pour-over", "espresso", "french-press"];

function choose<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

const KEYS: KeyPlan[] = [
  {
    name: "Research agent",
    perRequestMaxCents: 10,
    dailyCapCents: 100,
    cremaOnly: false,
    weight: 0.5,
    pick: (random) => `/articles/${choose(random, ARTICLES)}`,
  },
  {
    name: "Price watcher",
    perRequestMaxCents: 2,
    dailyCapCents: 50,
    cremaOnly: true,
    weight: 0.35,
    pick: (random) => {
      const grams = choose(random, [15, 18, 20, 22, 30]);
      return `/api/brew-ratio?method=${choose(random, BREW_METHODS)}&coffeeGrams=${grams}`;
    },
  },
  {
    name: "Newsletter bot",
    perRequestMaxCents: 50,
    dailyCapCents: 200,
    cremaOnly: true,
    weight: 0.15,
    pick: (random) =>
      random() < 0.3
        ? "/articles/premium-grinder-roundup"
        : `/articles/${choose(random, ARTICLES)}`,
  },
];

/** mulberry32, seeded from the run key: the same key always plans the same traffic. */
function prng(seedText: string): () => number {
  let seed = createHash("sha256").update(seedText).digest().readUInt32LE(0);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PlannedRequest {
  index: number;
  key: KeyPlan;
  path: string;
  priceCents: number;
  at: Date;
}

/** About 150 requests: ~7 a day growing to ~16, quieter at weekends, none in the future. */
function planTraffic(runKey: string, now: Date): PlannedRequest[] {
  const random = prng(`traffic:${PLAN_VERSION}:${runKey}`);
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const plan: Omit<PlannedRequest, "index">[] = [];
  for (let day = 0; day < DAYS; day++) {
    const dayStart = todayStart - (DAYS - 1 - day) * DAY_MS;
    const weekday = new Date(dayStart).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const count = Math.max(
      2,
      Math.round((6.5 + day * 0.7 + (random() * 4 - 2)) * (weekend ? 0.65 : 1.1)),
    );
    // Today only up to a minute ago; earlier days across the whole day.
    const span = day === DAYS - 1 ? Math.max(60_000, now.getTime() - dayStart - 60_000) : DAY_MS;
    for (let i = 0; i < count; i++) {
      const roll = random();
      let acc = 0;
      const key = KEYS.find((k) => {
        acc += k.weight;
        return roll < acc;
      }) as KeyPlan;
      const path = key.pick(random);
      const at = new Date(dayStart + Math.floor(random() * span));
      plan.push({ key, path, priceCents: priceCentsFor("GET", path.split("?")[0] ?? path), at });
    }
  }
  plan.sort((a, b) => a.at.getTime() - b.at.getTime());
  return plan.map((request, index) => ({ ...request, index }));
}

/** 32 hex characters, unique per run key and request. */
function nonceFor(runKey: string, index: number): string {
  return createHash("sha256")
    .update(`traffic:${PLAN_VERSION}:${runKey}:${index}`)
    .digest("hex")
    .slice(0, 32);
}

async function ensureKey(
  db: Db,
  ownerUserId: string,
  plan: KeyPlan,
  siteId: string,
): Promise<{ key: AgentKey; created: boolean }> {
  const existing = (await listAgentKeys(db, ownerUserId)).find(
    (key) => key.name === plan.name && key.status === "active",
  );
  if (existing) return { key: existing, created: false };
  // The private half is thrown away: these keys only ever pay through this script.
  const { publicJwk } = await generateAgentKeyPair();
  const key = await createAgentKey(db, {
    ownerUserId,
    name: plan.name,
    publicJwk,
    perRequestMaxCents: plan.perRequestMaxCents,
    dailyCapCents: plan.dailyCapCents,
    allowedSiteIds: plan.cremaOnly ? [siteId] : null,
  });
  return { key, created: true };
}

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

    const keys = new Map<string, AgentKey>();
    for (const plan of KEYS) {
      const { key, created } = await ensureKey(db, owner.id, plan, site.id);
      keys.set(plan.name, key);
      console.log(`Agent key    ${key.id} ${plan.name} ${created ? "issued" : "reused"}`);
    }

    const now = new Date();
    const plan = planTraffic(runKey, now);
    const plannedCents = plan.reduce((sum, request) => sum + request.priceCents, 0);
    const funded = await seedWallet(db, {
      ownerUserId: owner.id,
      cents: plannedCents,
      idempotencyKey: `traffic:${PLAN_VERSION}:${runKey}:${owner.id}`,
      memo: `Demo traffic budget (run ${runKey})`,
    });
    console.log(
      `Wallet       ${funded.created ? `topped up ${usd(plannedCents * 10_000)} (seed)` : "already funded for this run"}`,
    );

    const stats = new Map<string, { paid: number; micros: number }>();
    const refused = new Map<string, number>();
    const receiptIds: string[] = [];
    let alreadyPaid = 0;
    for (const request of plan) {
      const key = keys.get(request.key.name) as AgentKey;
      const ledger = new PostgresPrepaidLedger(db, { now: () => request.at });
      const result = await ledger.charge({
        keyId: key.id,
        nonce: nonceFor(runKey, request.index),
        amountCents: request.priceCents,
        payTo: site.id,
        network: PAYPAL_SANDBOX,
        resourceUrl: `${site.origin}${request.path}`,
        expiresAt: Math.floor(request.at.getTime() / 1000) + 60,
      });
      if (result.ok) {
        receiptIds.push(result.transaction);
        const entry = stats.get(request.key.name) ?? { paid: 0, micros: 0 };
        entry.paid++;
        entry.micros += request.priceCents * 10_000;
        stats.set(request.key.name, entry);
      } else if (result.reason === ErrorReason.NonceUsed) {
        alreadyPaid++;
      } else {
        refused.set(result.reason, (refused.get(result.reason) ?? 0) + 1);
      }
    }

    const first = plan[0]?.at.toISOString().slice(0, 10);
    const last = plan.at(-1)?.at.toISOString().slice(0, 10);
    console.log(`Traffic      ${plan.length} requests planned, ${first} to ${last}`);
    for (const [name, entry] of stats) {
      console.log(`             ${name}: ${entry.paid} paid, ${usd(entry.micros)}`);
    }
    if (alreadyPaid > 0)
      console.log(`             ${alreadyPaid} already settled by an earlier run`);
    for (const [reason, count] of refused) {
      console.log(`             ${count} refused by the ledger (${reason})`);
    }

    // Two publisher refunds (duplicate fetches), keyed by receipt so they happen once.
    let refunds = 0;
    for (const receiptId of [receiptIds[11], receiptIds[57]]) {
      if (!receiptId) continue;
      const refund = await refundReceipt(db, {
        receiptId,
        siteId: site.id,
        memo: "Duplicate fetch, refunded by Crema Notes",
      });
      if (refund.ok && !refund.alreadyRefunded) refunds++;
    }
    if (refunds > 0) console.log(`Refunds      ${refunds} receipts refunded by the publisher`);

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
