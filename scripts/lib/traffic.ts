/**
 * The plan and settlement behind `pnpm seed:traffic` (scripts/traffic.ts prints the results).
 *
 * The plan is a pure function of the run key and an anchor time. The anchor is fixed on the first
 * run of a run key and stored in the memo of that run's wallet funding, so a rerun on any later
 * day rebuilds exactly the same requests, nonces and refunds and moves no money.
 */
import { createHash } from "node:crypto";
import {
  type AgentKey,
  createAgentKey,
  type Db,
  getLedgerTransactionByKey,
  listAgentKeys,
  PostgresPrepaidLedger,
  refundReceipt,
  type Site,
  seedWallet,
} from "@botfare/core";
import { ErrorReason, generateAgentKeyPair, PAYPAL_SANDBOX } from "@botfare/x402-paypal";
import { priceCentsFor } from "../../apps/demo/src/pricing";

const DAYS = 14;
/** Part of every nonce and funding key: bump it when the plan changes so runs never overlap. */
const PLAN_VERSION = "v2";
const DAY_MS = 24 * 3600 * 1000;

export interface KeyPlan {
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

export const KEYS: KeyPlan[] = [
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

export interface PlannedRequest {
  index: number;
  key: KeyPlan;
  path: string;
  priceCents: number;
  at: Date;
}

/** About 150 requests: ~7 a day growing to ~16, quieter at weekends, none in the future. */
export function planTraffic(runKey: string, now: Date): PlannedRequest[] {
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
export function nonceFor(runKey: string, index: number): string {
  return createHash("sha256")
    .update(`traffic:${PLAN_VERSION}:${runKey}:${index}`)
    .digest("hex")
    .slice(0, 32);
}

export async function ensureKey(
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

/** The `seedWallet` key that funds one run (seedWallet stores it as `seed:<key>`). */
/** The run key of the weekly refresh: `week-<ISO year>-W<ISO week>` of `date` (UTC). */
export function weeklyRunKey(date: Date): string {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // The Thursday of the (Monday-first) week decides the ISO year.
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return `week-${year}-W${String(week).padStart(2, "0")}`;
}

export function fundingKey(runKey: string, ownerUserId: string): string {
  return `traffic:${PLAN_VERSION}:${runKey}:${ownerUserId}`;
}

const ANCHOR_MEMO = /anchored at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

/**
 * The time a run key's plan is built from: the one stored with its funding, or `now` on the first
 * run. Funding from before the anchor was stored falls back to the funding's own time, which is
 * within milliseconds of the time that plan used.
 */
export async function planAnchor(
  db: Db,
  runKey: string,
  ownerUserId: string,
  now: Date,
): Promise<{ anchor: Date; firstRun: boolean }> {
  const funding = await getLedgerTransactionByKey(db, `seed:${fundingKey(runKey, ownerUserId)}`);
  if (!funding) return { anchor: now, firstRun: true };
  const stored = ANCHOR_MEMO.exec(funding.memo ?? "")?.[1];
  return { anchor: stored ? new Date(stored) : funding.createdAt, firstRun: false };
}

export interface TrafficRun {
  plan: PlannedRequest[];
  anchor: Date;
  plannedCents: number;
  funded: boolean;
  keys: { name: string; key: AgentKey; created: boolean }[];
  paid: Map<string, { paid: number; micros: number }>;
  alreadyPaid: number;
  refused: Map<string, number>;
  refunds: number;
}

/** Issues the keys, funds the plan once and settles every planned request (see scripts/traffic.ts). */
export async function runTraffic(
  db: Db,
  input: { runKey: string; ownerUserId: string; site: Site; now?: Date },
): Promise<TrafficRun> {
  const { runKey, ownerUserId, site } = input;
  const keys: TrafficRun["keys"] = [];
  const byName = new Map<string, AgentKey>();
  for (const plan of KEYS) {
    const { key, created } = await ensureKey(db, ownerUserId, plan, site.id);
    keys.push({ name: plan.name, key, created });
    byName.set(plan.name, key);
  }

  const { anchor } = await planAnchor(db, runKey, ownerUserId, input.now ?? new Date());
  const plan = planTraffic(runKey, anchor);
  const plannedCents = plan.reduce((sum, request) => sum + request.priceCents, 0);
  const funded = await seedWallet(db, {
    ownerUserId,
    cents: plannedCents,
    idempotencyKey: fundingKey(runKey, ownerUserId),
    memo: `Demo traffic budget (run ${runKey}, anchored at ${anchor.toISOString()})`,
  });

  const paid = new Map<string, { paid: number; micros: number }>();
  const refused = new Map<string, number>();
  const receiptIds: string[] = [];
  let alreadyPaid = 0;
  for (const request of plan) {
    const key = byName.get(request.key.name) as AgentKey;
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
      const entry = paid.get(request.key.name) ?? { paid: 0, micros: 0 };
      entry.paid++;
      entry.micros += request.priceCents * 10_000;
      paid.set(request.key.name, entry);
    } else if (result.reason === ErrorReason.NonceUsed) {
      alreadyPaid++;
    } else {
      refused.set(result.reason, (refused.get(result.reason) ?? 0) + 1);
    }
  }

  // Two publisher refunds (duplicate fetches), keyed by receipt so they happen once. A rerun
  // settles nothing new (every nonce is already used), so it refunds nothing either.
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

  return {
    plan,
    anchor,
    plannedCents,
    funded: funded.created,
    keys,
    paid,
    alreadyPaid,
    refused,
    refunds,
  };
}
