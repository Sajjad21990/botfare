/**
 * The Fare Court and Fare Advisor part of `pnpm seed:traffic`: the signals agents would have left
 * around the paid traffic in scripts/lib/traffic.ts, written through the same core services the
 * live endpoints use, so the Advisor and the Disputes tab have a story to tell.
 *
 * Over the same 14 days as the paid traffic (anchored to the same time):
 * - offers shown (middleware telemetry): one before every paid request on Crema Notes and before
 *   every decline note, plus agents that looked at an offer and left without a word, on every
 *   article and the brew API;
 * - decline notes: the 50¢ premium roundup is turned down again and again ("Thin listicle, not
 *   worth 50¢", "Preview lists names only", over the per-page cap), and a few other pages for
 *   other reasons;
 * - citations: the research and newsletter agents' answers cite burr-basics and dialing-in most
 *   often, the premium roundup rarely;
 * - Fare Court: the research agent buys the 3¢ grinder-maintenance article four times and gets the
 *   "subscribe to keep reading" stub; Crema Notes attests the stub's digest; each purchase is
 *   disputed with the stub's exact bytes. Three verdicts refund by policy (refund, 90%+ sure); the
 *   latest one is less sure (72%) and waits for the publisher.
 *
 * The verdicts are scripted (this is seeded demo data, no model runs); the money still moves only
 * through applyVerdict's policy and refundReceipt, exactly as live. Everything is idempotent per
 * run key: purchase nonces, the wallet funding and the refunds are keyed, decline notes are unique
 * per key, URL and day, citation reports replace each other by answer ID, disputes are refused once
 * a receipt has one, and the telemetry is written once (checked by its first synthetic event).
 */
import { createHash } from "node:crypto";
import {
  contentDigestSha256,
  type DeclineCategory,
  type DisputeVerdict,
} from "@botfare/contracts/fare";
import {
  type AgentKey,
  applyVerdict,
  attestReceipt,
  type Db,
  listAgentKeys,
  listReceipts,
  openDispute,
  PostgresPrepaidLedger,
  type Receipt,
  recordCitations,
  recordDecline,
  recordOfferTelemetry,
  type Site,
  seedWallet,
} from "@botfare/core";
import { PAYPAL_SANDBOX } from "@botfare/x402-paypal";
import { FARE_COURT_STUB_SLUG } from "../../apps/demo/src/app";
import { loadArticles, truncate } from "../../apps/demo/src/content";
import { subscribeStubPage } from "../../apps/demo/src/pages";
import { priceCentsFor } from "../../apps/demo/src/pricing";

/** Part of every key this module writes: bump it when the story changes so runs never overlap. */
const STORY_VERSION = "v1";
const DAYS = 14;
const DAY_MS = 24 * 3600 * 1000;
const MINUTE_MS = 60_000;

const PREMIUM_PATH = "/articles/premium-grinder-roundup";
const STUB_PATH = `/articles/${FARE_COURT_STUB_SLUG}`;
/** Days of the window (0 = oldest, 13 = the anchor's day) on which the research agent buys the stub. */
const STUB_DAYS = [3, 6, 9, 12];
/** Agents that write answers (and so cite and decline): the traffic keys plus the demo key. */
const CITING_KEYS = ["Research agent", "Newsletter bot"];
const DECLINING_KEYS = ["Research agent", "Newsletter bot", "Demo research agent"];

/** Same generator as the traffic plan, seeded from the run key. */
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

/** A number in [0, 1) fixed by the text alone (independent of anything else in the database). */
function unit(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32LE(0) / 4294967296;
}

function weighted<T>(random: () => number, items: readonly (readonly [number, T])[]): T {
  const total = items.reduce((sum, [weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [weight, item] of items) {
    roll -= weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1]?.[1] as T;
}

type DeclineTemplate = { category: DeclineCategory; reason: string };

/** Why agents turn the 50¢ roundup down (the case-insensitive spelling groups in the Advisor). */
const PREMIUM_DECLINES: (readonly [number, DeclineTemplate])[] = [
  [5, { category: "too_expensive", reason: "Thin listicle, not worth 50¢" }],
  [3, { category: "low_quality_preview", reason: "Preview lists names only" }],
  [2, { category: "over_budget", reason: "Over this agent's per-page cap" }],
  [1, { category: "low_quality_preview", reason: "Clickbait preview, no test data" }],
];

const OTHER_DECLINES: { path: string; day: number; key: string; note: DeclineTemplate }[] = [
  {
    path: "/articles/latte-art-hearts",
    day: 2,
    key: "Research agent",
    note: { category: "irrelevant", reason: "About milk art; the question was about grinders" },
  },
  {
    path: "/articles/latte-art-hearts",
    day: 8,
    key: "Demo research agent",
    note: { category: "irrelevant", reason: "About milk art; the question was about grinders" },
  },
  {
    path: "/articles/grinders-under-200",
    day: 5,
    key: "Newsletter bot",
    note: { category: "already_have", reason: "Already bought this guide for an earlier answer" },
  },
  {
    path: "/articles/dialing-in-espresso",
    day: 11,
    key: "Demo research agent",
    note: { category: "over_budget", reason: "Run budget spent on two other pages" },
  },
];

/** What an answer took from each page (shown next to the citation in analytics). */
const CLAIMS: Record<string, string> = {
  "/articles/burr-basics": "Conical and flat burrs: how burr geometry shapes the grind",
  "/articles/dialing-in-espresso": "Change one variable at a time, starting with grind size",
  "/articles/latte-art-hearts": "Steam milk to 55–60 °C for a glossy microfoam",
  "/articles/grinders-under-200": "Budget burr grinders worth buying",
  [PREMIUM_PATH]: "Named the high-end grinders in the roundup",
};

/** How often an agent's answer cites a page it paid for. */
const CITE_RATE: Record<string, number> = {
  "/articles/burr-basics": 0.85,
  "/articles/dialing-in-espresso": 0.8,
  "/articles/grinders-under-200": 0.35,
  "/articles/latte-art-hearts": 0.25,
  [PREMIUM_PATH]: 0.1,
};

/** Scripted verdicts for the stub disputes: the last one is not sure enough to refund by itself. */
function stubVerdict(index: number): DisputeVerdict {
  const sure = index < STUB_DAYS.length - 1;
  return {
    decision: "refund",
    confidence: sure ? 0.93 : 0.72,
    category: "stub_or_paywall",
    rationale: sure
      ? "The offer declared a step-by-step maintenance guide; the delivered page repeats the one-sentence summary and then a 'Subscribe to keep reading' wall. None of the promised steps were delivered."
      : "The page shows the summary the preview promised and then a subscription wall. The steps are missing, but the summary itself matches the offer, so the share of the promise that was kept is unclear.",
    evidence: [
      {
        declared: "Grinder maintenance, step by step",
        delivered: "Subscribe to keep reading",
      },
    ],
  };
}

function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function dayStart(anchor: Date, day: number): number {
  const today = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  return today - (DAYS - 1 - day) * DAY_MS;
}

/** A time on `day` at `hours` UTC plus up to `jitterMin` minutes, never after the anchor. */
function timeOn(anchor: Date, day: number, hours: number, jitter: number): Date {
  const at = dayStart(anchor, day) + hours * 3600_000 + Math.floor(jitter);
  return new Date(Math.min(at, anchor.getTime() - MINUTE_MS));
}

function stubNonce(runKey: string, index: number): string {
  return createHash("sha256")
    .update(`fare:${STORY_VERSION}:${runKey}:stub:${index}`)
    .digest("hex")
    .slice(0, 32);
}

export interface FareStoryRun {
  stub: {
    purchased: number;
    alreadyPurchased: number;
    refused: string[];
    attested: number;
    disputes: { refunded: number; pending: number; other: number; alreadyFiled: number };
  };
  declines: { recorded: number; duplicates: number };
  offers: { inserted: number; skipped: boolean };
  citations: { answers: number; cited: number };
}

/** Writes the story; `anchor` is the paid traffic's anchor (planAnchor in scripts/lib/traffic.ts). */
export async function runFareStory(
  db: Db,
  input: { runKey: string; ownerUserId: string; site: Site; anchor: Date },
): Promise<FareStoryRun> {
  const { runKey, ownerUserId, site, anchor } = input;
  const keys = new Map<string, AgentKey>();
  for (const key of await listAgentKeys(db, ownerUserId)) {
    if (key.status === "active" && !keys.has(key.name)) keys.set(key.name, key);
  }
  const researchKey = keys.get("Research agent");
  if (!researchKey)
    throw new Error("The Research agent key is missing: run the paid traffic first");

  const run: FareStoryRun = {
    stub: {
      purchased: 0,
      alreadyPurchased: 0,
      refused: [],
      attested: 0,
      disputes: { refunded: 0, pending: 0, other: 0, alreadyFiled: 0 },
    },
    declines: { recorded: 0, duplicates: 0 },
    offers: { inserted: 0, skipped: false },
    citations: { answers: 0, cited: 0 },
  };
  const random = prng(`fare:${STORY_VERSION}:${runKey}`);

  // 1. Fare Court: stub purchases, attestations and disputes.
  const article = loadArticles().find((a) => a.slug === FARE_COURT_STUB_SLUG);
  if (!article) throw new Error(`apps/demo has no ${FARE_COURT_STUB_SLUG} article`);
  const stubBytes = new TextEncoder().encode(subscribeStubPage(article));
  const stubDigest = await contentDigestSha256(stubBytes);
  const stubPrice = priceCentsFor("GET", STUB_PATH);
  // What botfare() declares for this page (apps/demo previewFor): the offer the stub breaks.
  const declared = {
    title: article.title,
    preview: truncate(article.lead, 280),
    wordCount: article.wordCount,
  };
  await seedWallet(db, {
    ownerUserId,
    cents: stubPrice * STUB_DAYS.length,
    idempotencyKey: `fare:${STORY_VERSION}:${runKey}:${ownerUserId}`,
    memo: `Demo Fare Court purchases (run ${runKey})`,
  });

  const stubTimes = STUB_DAYS.map((day) => timeOn(anchor, day, 9, random() * 8 * 3600_000));
  for (const [index, at] of stubTimes.entries()) {
    const ledger = new PostgresPrepaidLedger(db, { now: () => at });
    const charged = await ledger.charge({
      keyId: researchKey.id,
      nonce: stubNonce(runKey, index),
      amountCents: stubPrice,
      payTo: site.id,
      network: PAYPAL_SANDBOX,
      resourceUrl: `${site.origin}${STUB_PATH}`,
      expiresAt: Math.floor(at.getTime() / 1000) + 60,
      extra: { botfareOffer: declared },
    });
    let receiptId: string | undefined;
    if (charged.ok) {
      run.stub.purchased++;
      receiptId = charged.transaction;
    } else if (charged.originalTransaction) {
      run.stub.alreadyPurchased++;
      receiptId = charged.originalTransaction;
    } else {
      run.stub.refused.push(charged.reason);
      continue;
    }

    const attested = await attestReceipt(db, {
      siteId: site.id,
      receiptId,
      attestation: {
        contentDigest: stubDigest,
        contentLength: stubBytes.length,
        contentType: "text/html; charset=utf-8",
        status: 200,
      },
    });
    if (!attested.ok) throw new Error(`Attesting ${receiptId}: ${attested.message}`);
    if (!attested.alreadyAttested) run.stub.attested++;

    const filedAt = new Date(at.getTime() + 2 * MINUTE_MS);
    const opened = await openDispute(db, {
      agentKeyId: researchKey.id,
      request: {
        receiptId,
        reason: "stub_or_paywall",
        note: "Paid for the step-by-step maintenance guide; got the summary and a subscribe wall.",
        contentBase64: Buffer.from(stubBytes).toString("base64"),
      },
      contentBytes: stubBytes,
      now: filedAt,
    });
    if (!opened.ok) {
      if (opened.reason === "already_open" || opened.reason === "already_decided") {
        run.stub.disputes.alreadyFiled++;
      } else if (opened.reason === "already_refunded") {
        run.stub.disputes.alreadyFiled++;
      } else {
        throw new Error(`Disputing ${receiptId}: ${opened.reason} (${opened.message})`);
      }
      continue;
    }
    const decided = await applyVerdict(db, {
      disputeId: opened.dispute.id,
      verdict: stubVerdict(index),
      autoAllowed: opened.autoAllowed,
      now: new Date(filedAt.getTime() + 4_000),
    });
    if (!decided.ok) throw new Error(`Deciding ${opened.dispute.id}: ${decided.message}`);
    if (decided.outcome.status === "refunded") run.stub.disputes.refunded++;
    else if (decided.outcome.status === "pending_publisher") run.stub.disputes.pending++;
    else run.stub.disputes.other++;
  }

  // 2. Decline notes (each one follows an offer the agent was shown).
  const premiumUrl = `${site.origin}${PREMIUM_PATH}`;
  const premiumPrice = priceCentsFor("GET", PREMIUM_PATH);
  const declines: { keyName: string; path: string; at: Date; note: DeclineTemplate }[] = [];
  for (let day = 0; day < DAYS; day++) {
    for (const keyName of DECLINING_KEYS) {
      if (random() > 0.62) continue;
      const at = timeOn(anchor, day, 7, random() * 14 * 3600_000);
      declines.push({ keyName, path: PREMIUM_PATH, at, note: weighted(random, PREMIUM_DECLINES) });
    }
  }
  for (const other of OTHER_DECLINES) {
    declines.push({
      keyName: other.key,
      path: other.path,
      at: timeOn(anchor, other.day, 11, random() * 6 * 3600_000),
      note: other.note,
    });
  }
  for (const decline of declines) {
    const key = keys.get(decline.keyName);
    if (!key) continue;
    const recorded = await recordDecline(db, {
      agentKeyId: key.id,
      note: {
        url: decline.path === PREMIUM_PATH ? premiumUrl : `${site.origin}${decline.path}`,
        priceCents:
          decline.path === PREMIUM_PATH ? premiumPrice : priceCentsFor("GET", decline.path),
        category: decline.note.category,
        reason: decline.note.reason,
      },
      now: decline.at,
    });
    if (!recorded.ok) throw new Error(`Decline note: ${recorded.reason} (${recorded.message})`);
    if (recorded.recorded) run.declines.recorded++;
    else run.declines.duplicates++;
  }

  // 3. Offers shown: browsing agents that left without a word (fixed by the run key), then one
  // offer before every decline and every paid request on the site in the window.
  const windowStart = dayStart(anchor, 0);
  const browsing: { path: string; at: Date; priceCents: number }[] = [];
  const browsedPaths = [...loadArticles().map((a) => `/articles/${a.slug}`), "/api/brew-ratio"];
  for (let day = 0; day < DAYS; day++) {
    for (const path of browsedPaths) {
      const extra = path === PREMIUM_PATH ? 1 + Math.floor(random() * 3) : Math.floor(random() * 3);
      for (let i = 0; i < extra; i++) {
        browsing.push({
          path,
          at: timeOn(anchor, day, 0, random() * DAY_MS),
          priceCents: priceCentsFor("GET", path),
        });
      }
    }
  }
  const first = browsing[0];
  const alreadyWritten =
    first &&
    (await db.query.offerEvents.findFirst({
      where: (t, { and, eq }) =>
        and(eq(t.siteId, site.id), eq(t.path, first.path), eq(t.at, first.at)),
    }));
  if (alreadyWritten) {
    run.offers.skipped = true;
  } else {
    const siteReceipts = (await listReceipts(db, { siteId: site.id, limit: 500 })).filter(
      (receipt) =>
        receipt.createdAt.getTime() >= windowStart &&
        receipt.createdAt.getTime() <= anchor.getTime(),
    );
    const events = [
      ...browsing.map((b) => ({ ...b, signal: "automation" as const })),
      ...declines.map((d) => ({
        path: d.path,
        at: new Date(d.at.getTime() - 5_000),
        priceCents: priceCentsFor("GET", d.path),
        signal: "signed-agent" as const,
      })),
      ...siteReceipts.flatMap((receipt) => {
        const path = pathOf(receipt.resourceUrl);
        if (!path) return [];
        return [
          {
            path,
            at: new Date(receipt.createdAt.getTime() - 3_000),
            priceCents: receipt.amountCents,
            signal: receipt.detectionSignal ?? ("agent-header" as const),
          },
        ];
      }),
    ];
    // Batches by UTC day, so every event is inside the telemetry window of its batch's clock.
    const byDay = new Map<number, typeof events>();
    for (const event of events) {
      const day = Math.floor(event.at.getTime() / DAY_MS);
      byDay.set(day, [...(byDay.get(day) ?? []), event]);
    }
    for (const dayEvents of byDay.values()) {
      for (let i = 0; i < dayEvents.length; i += 500) {
        const batch = dayEvents.slice(i, i + 500);
        const now = new Date(Math.max(...batch.map((event) => event.at.getTime())) + 1_000);
        const result = await recordOfferTelemetry(
          db,
          site.id,
          {
            events: batch.map((event) => ({
              path: event.path,
              method: "GET",
              priceCents: event.priceCents,
              signal: event.signal,
              at: event.at.toISOString(),
            })),
          },
          { now },
        );
        if (!result.ok) throw new Error(`Telemetry: ${result.message}`);
        run.offers.inserted += result.accepted;
      }
    }
  }

  // 4. Citations: each agent's answers of the day cite some of the pages it paid for.
  for (const [keyIndex, keyName] of CITING_KEYS.entries()) {
    const key = keys.get(keyName);
    if (!key) continue;
    const paid = (await listReceipts(db, { agentKeyId: key.id, limit: 500 })).filter(
      (receipt) =>
        receipt.status === "settled" &&
        receipt.siteId === site.id &&
        receipt.createdAt.getTime() >= windowStart &&
        receipt.createdAt.getTime() <= anchor.getTime(),
    );
    const answers = new Map<string, Receipt[]>();
    for (const receipt of paid) {
      const path = pathOf(receipt.resourceUrl) ?? "";
      const rate = CITE_RATE[path] ?? 0;
      if (unit(`cite:${STORY_VERSION}:${runKey}:${receipt.id}`) >= rate) continue;
      const day = receipt.createdAt.toISOString().slice(0, 10).replaceAll("-", "");
      const answerId = `story-${runKey}-${keyIndex}-${day}`;
      answers.set(answerId, [...(answers.get(answerId) ?? []), receipt]);
    }
    for (const [answerId, cited] of answers) {
      for (let i = 0; i < cited.length; i += 20) {
        const chunk = cited.slice(i, i + 20);
        const last = Math.max(...chunk.map((receipt) => receipt.createdAt.getTime()));
        const result = await recordCitations(db, {
          agentKeyId: key.id,
          report: {
            answerId: i === 0 ? answerId : `${answerId}-${i / 20}`,
            citations: chunk.map((receipt) => ({
              receiptId: receipt.id,
              claim: CLAIMS[pathOf(receipt.resourceUrl) ?? ""] ?? "",
            })),
          },
          now: new Date(last + 4 * MINUTE_MS),
        });
        if (!result.ok) throw new Error(`Citations: ${result.message}`);
        run.citations.answers++;
        run.citations.cited += result.recorded;
      }
    }
  }

  return run;
}
