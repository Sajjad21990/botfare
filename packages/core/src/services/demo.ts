/**
 * Judge mode keeps the shared demo working. Every judge who picks "Publisher" is the same user, so
 * each persona sign-in puts back what one judge could have changed for the next: the demo site's
 * prices, free paths and bot detection, the payout email, enough earnings to try "Withdraw now"
 * again, and a Fare Court dispute waiting for review.
 *
 * The demo publisher was renamed once (Crema Notes became Saffron & Salt). The demo site is found
 * by DEMO_SITE_NAME and, failing that, by a name in LEGACY_DEMO_SITE_NAMES, which is renamed in
 * place; migrateLegacyDemoPublisher moves the persona user from a legacy email the same way.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  CREMA_NOTES_DETECTION,
  DEMO_PERSONAS,
  DEMO_SITE_FREE_PATHS,
  DEMO_SITE_NAME,
  DEMO_SITE_PRICING,
  findPricingRule,
  isDemoPersonaEmail,
  LEGACY_DEMO_PUBLISHER_EMAILS,
  LEGACY_DEMO_SITE_NAMES,
  type PricingRule,
} from "@botfare/contracts";
import { contentDigestSha256, DISPUTE_POLICY, type DisputeVerdict } from "@botfare/contracts/fare";
import { centsToMicros, PAYPAL_SANDBOX } from "@botfare/x402-paypal";
import { and, count, desc, eq, isNotNull } from "drizzle-orm";
import { Accounts } from "../accounts";
import type { Db } from "../db";
import { postTransaction, walletBalanceMicros } from "../ledger";
import { PostgresPrepaidLedger } from "../postgres-ledger";
import { disputes, ledgerEntries, payouts, receipts, type Site, type User, users } from "../schema";
import { applyVerdict, attestReceipt, openDispute } from "./fare-court";
import { publisherEarningsSplit, setPayoutEmail } from "./payouts";
import {
  listSites,
  siteDetection,
  updateSiteDetection,
  updateSitePricing,
  updateSiteProfile,
} from "./sites";
import { getUserByEmail } from "./users";

/**
 * Available earnings (not counting fares still clearing in the dispute window) the publisher
 * persona has at sign-in, so every judge can try a $1.00+ withdrawal.
 */
export const DEMO_EARNINGS_FLOOR_CENTS = 200;
/** Wallet balance the agent-owner persona keeps, so the shared research agent can always pay. */
export const DEMO_WALLET_FLOOR_CENTS = 500;

export interface DemoPublisherReset {
  /** Demo sites found under a legacy name and renamed to DEMO_SITE_NAME. */
  renamed: number;
  /** Demo sites whose prices were put back. */
  pricingReset: number;
  /** Demo sites whose bot detection was put back. */
  detectionReset: number;
  payoutEmailReset: boolean;
  /** Demo earnings added this time (0 when available earnings already reached the floor). */
  earningsAddedCents: number;
  /** Fare Court disputes put back in the publisher's review queue (one per demo site at most). */
  pendingDisputesAdded: number;
}

/**
 * Restores the publisher persona's demo state. Idempotent: prices are written only when they
 * differ (so the middleware's cached config stays valid), and the earnings top-up is keyed by the
 * publisher's latest payout, so it happens at most once per withdrawal that emptied the balance.
 */
export async function resetDemoPublisher(
  db: Db,
  input: { userId: string; payoutEmail: string | null; earningsFloorCents?: number },
): Promise<DemoPublisherReset> {
  let pricingReset = 0;
  let detectionReset = 0;
  const found = findDemoSites(await listSites(db, input.userId));
  const demoSites: string[] = [];
  for (const site of found) {
    demoSites.push(site.id);
    if (site.name !== DEMO_SITE_NAME) {
      await updateSiteProfile(db, {
        siteId: site.id,
        ownerUserId: input.userId,
        name: DEMO_SITE_NAME,
      });
    }
    if (
      !samePricing(site.pricing, DEMO_SITE_PRICING) ||
      JSON.stringify(site.freePaths) !== JSON.stringify(DEMO_SITE_FREE_PATHS) ||
      site.chargeKnownBots !== false
    ) {
      await updateSitePricing(db, {
        siteId: site.id,
        ownerUserId: input.userId,
        pricing: DEMO_SITE_PRICING,
        freePaths: DEMO_SITE_FREE_PATHS,
        chargeKnownBots: false,
      });
      pricingReset += 1;
    }
    if (canonical(siteDetection(site)) !== canonical(CREMA_NOTES_DETECTION)) {
      await updateSiteDetection(db, {
        siteId: site.id,
        ownerUserId: input.userId,
        detection: CREMA_NOTES_DETECTION,
      });
      detectionReset += 1;
    }
  }

  let payoutEmailReset = false;
  if (input.payoutEmail) {
    const [user] = await db
      .select({ payoutEmail: users.payoutEmail })
      .from(users)
      .where(eq(users.id, input.userId));
    if (user && user.payoutEmail !== input.payoutEmail.trim().toLowerCase()) {
      await setPayoutEmail(db, { userId: input.userId, email: input.payoutEmail });
      payoutEmailReset = true;
    }
  }

  // The floor applies to what Withdraw can pay now: fares bought minutes ago are still clearing.
  const floorMicros = centsToMicros(input.earningsFloorCents ?? DEMO_EARNINGS_FLOOR_CENTS);
  const { availableMicros: available } = await publisherEarningsSplit(db, input.userId);
  let earningsAddedCents = 0;
  if (available < floorMicros) {
    const [latest] = await db
      .select({ id: payouts.id })
      .from(payouts)
      .where(eq(payouts.publisherUserId, input.userId))
      .orderBy(desc(payouts.createdAt), desc(payouts.id))
      .limit(1);
    // Whole cents, so the ledger stays in step with what a payout can send.
    const cents = Math.ceil((floorMicros - available) / centsToMicros(1));
    const amount = centsToMicros(cents);
    const posted = await postTransaction(db, {
      kind: "seed",
      idempotencyKey: `demo-earnings:${input.userId}:${latest?.id ?? "start"}`,
      memo: "Demo earnings so the next judge can try Withdraw now",
      entries: [
        { accountId: Accounts.earnings(input.userId), amountMicros: amount },
        { accountId: Accounts.paypalClearing, amountMicros: -amount },
      ],
    });
    if (posted.created) earningsAddedCents = cents;
  }

  // Last, so a problem here never keeps the other resets from happening.
  let pendingDisputesAdded = 0;
  for (const siteId of demoSites) {
    try {
      if ((await ensureDemoPendingDispute(db, { siteId })).added) pendingDisputesAdded += 1;
    } catch (err) {
      console.error(`demo: could not put a dispute back in review for ${siteId}`, err);
    }
  }

  return {
    renamed: found.filter((site) => site.name !== DEMO_SITE_NAME).length,
    pricingReset,
    detectionReset,
    payoutEmailReset,
    earningsAddedCents,
    pendingDisputesAdded,
  };
}

/**
 * The publisher's demo sites: those named DEMO_SITE_NAME, or, when there is none, those still
 * under a legacy name (a database seeded before the rename), in the order given.
 */
export function findDemoSites<T extends Pick<Site, "name">>(sites: T[]): T[] {
  const current = sites.filter((site) => site.name === DEMO_SITE_NAME);
  if (current.length > 0) return current;
  return sites.filter((site) => LEGACY_DEMO_SITE_NAMES.includes(site.name));
}

export interface LegacyDemoPublisherMigration {
  /** The user that now has DEMO_PERSONAS.publisher's email, if any. */
  publisher: User | null;
  /** A user moved from a legacy email to the persona's email (same user ID, sites and history). */
  migrated: { userId: string; from: string } | null;
  /** Users with a legacy email left alone because the persona's email was already taken. */
  untouched: { userId: string; email: string }[];
}

/**
 * Moves the publisher persona off a legacy email (LEGACY_DEMO_PUBLISHER_EMAILS) in place: the
 * user keeps its ID, so its sites, receipts, payouts and sessions stay its own, and gets the
 * persona's email and name. When the persona's email already belongs to a user, that user is kept
 * and every legacy user is left untouched (the caller warns). Idempotent: once moved, there is
 * nothing left to move. The persona and legacy emails can be overridden (tests).
 */
export async function migrateLegacyDemoPublisher(
  db: Db,
  input: { email?: string; name?: string; legacyEmails?: readonly string[] } = {},
): Promise<LegacyDemoPublisherMigration> {
  const email = (input.email ?? DEMO_PERSONAS.publisher.email).trim().toLowerCase();
  const name = input.name ?? DEMO_PERSONAS.publisher.name;
  let publisher = await getUserByEmail(db, email);
  let migrated: LegacyDemoPublisherMigration["migrated"] = null;
  const untouched: LegacyDemoPublisherMigration["untouched"] = [];
  for (const legacyEmail of input.legacyEmails ?? LEGACY_DEMO_PUBLISHER_EMAILS) {
    const legacy = await getUserByEmail(db, legacyEmail);
    if (!legacy) continue;
    if (publisher) {
      untouched.push({ userId: legacy.id, email: legacy.email });
      continue;
    }
    const [moved] = await db
      .update(users)
      .set({ email, name })
      .where(and(eq(users.id, legacy.id), eq(users.email, legacy.email)))
      .returning();
    if (!moved) continue;
    publisher = moved;
    migrated = { userId: moved.id, from: legacy.email };
  }
  return { publisher, migrated, untouched };
}

export type DemoPendingDisputeResult =
  | { added: true; disputeId: string; receiptId: string }
  | { added: false; reason: string };

/**
 * Keeps one Fare Court dispute waiting for the publisher on the demo site, so every judge can try
 * Accept and Decline, not only the first. When none is pending, the latest dispute the publisher
 * decided (one a demo persona's key filed, with its delivered excerpt) is played again through the
 * live path: the same key buys the same page (a ledger charge), the site attests the excerpt's
 * bytes, the key disputes them, and that dispute's own verdict is applied with publisher review
 * required, so it waits in the queue. The purchase nonce is derived from that decided dispute, so
 * each decision brings back at most one case. Only demo personas' wallets are ever charged.
 */
export async function ensureDemoPendingDispute(
  db: Db,
  input: { siteId: string; now?: Date },
): Promise<DemoPendingDisputeResult> {
  const now = input.now ?? new Date();
  const [pending] = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(eq(disputes.siteId, input.siteId), eq(disputes.status, "pending_publisher")))
    .limit(1);
  if (pending) return { added: false, reason: "a dispute is already waiting for review" };

  const decided = await db
    .select({ dispute: disputes, receipt: receipts, ownerEmail: users.email })
    .from(disputes)
    .innerJoin(receipts, eq(receipts.id, disputes.receiptId))
    .innerJoin(users, eq(users.id, disputes.ownerUserId))
    .where(
      and(
        eq(disputes.siteId, input.siteId),
        eq(disputes.decidedBy, "publisher"),
        eq(disputes.contentDigestOk, true),
        isNotNull(disputes.deliveredExcerpt),
      ),
    )
    .orderBy(desc(disputes.decidedAt), desc(disputes.id))
    .limit(20);
  // Only a page the demo still sells: a case about a page from before the rename (Crema Notes'
  // coffee articles) is never played again on Saffron & Salt.
  const template = decided.find(
    (row) =>
      isDemoPersonaEmail(row.ownerEmail) &&
      row.dispute.deliveredExcerpt?.trim() &&
      isCurrentDemoPage(row.receipt.resourceUrl),
  );
  if (!template) return { added: false, reason: "no decided demo dispute to play again" };
  const { dispute, receipt } = template;

  const nonce = createHash("sha256")
    .update(`demo-pending-dispute:${dispute.id}`)
    .digest("hex")
    .slice(0, 32);
  const charged = await new PostgresPrepaidLedger(db, { now: () => now }).charge({
    keyId: receipt.agentKeyId,
    nonce,
    amountCents: receipt.amountCents,
    payTo: input.siteId,
    network: PAYPAL_SANDBOX,
    resourceUrl: receipt.resourceUrl ?? undefined,
    expiresAt: Math.floor(now.getTime() / 1000) + 60,
    ...(receipt.declaredOffer ? { extra: { botfareOffer: receipt.declaredOffer } } : {}),
  });
  let receiptId: string;
  if (charged.ok) receiptId = charged.transaction;
  else if (charged.originalTransaction) receiptId = charged.originalTransaction;
  else return { added: false, reason: `the demo purchase was refused (${charged.reason})` };

  const bytes = new TextEncoder().encode(dispute.deliveredExcerpt ?? "");
  const attested = await attestReceipt(db, {
    siteId: input.siteId,
    receiptId,
    attestation: {
      contentDigest: await contentDigestSha256(bytes),
      contentLength: bytes.length,
      contentType: receipt.contentType ?? "text/html",
      status: receipt.deliveredStatus ?? 200,
    },
  });
  if (!attested.ok) return { added: false, reason: attested.message };

  const opened = await openDispute(db, {
    agentKeyId: receipt.agentKeyId,
    request: {
      receiptId,
      reason: dispute.reason,
      ...(dispute.note ? { note: dispute.note } : {}),
      contentBase64: Buffer.from(bytes).toString("base64"),
    },
    contentBytes: bytes,
    limits: { maxDisputesPerDay: 200, autoRefundRateRule: false },
    now,
  });
  if (!opened.ok) return { added: false, reason: opened.message };
  // A confident deny would close the case without review; anything else goes to the publisher.
  const verdict = reviewable(dispute.verdict);
  const applied = await applyVerdict(db, {
    disputeId: opened.dispute.id,
    verdict,
    autoAllowed: false,
    now,
  });
  if (!applied.ok || applied.outcome.status !== "pending_publisher") {
    return { added: false, reason: "the replayed dispute did not go to review" };
  }
  return { added: true, disputeId: opened.dispute.id, receiptId };
}

/** True when the demo's pricing (DEMO_SITE_PRICING) still charges for this URL's path. */
function isCurrentDemoPage(url: string | null): boolean {
  if (!url) return false;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  const config = { pricing: DEMO_SITE_PRICING, freePaths: DEMO_SITE_FREE_PATHS };
  return findPricingRule(config, "GET", path) !== undefined;
}

function reviewable(verdict: DisputeVerdict | null): DisputeVerdict | null {
  if (!verdict) return null;
  return verdict.decision === "deny" && verdict.confidence >= DISPUTE_POLICY.autoDenyConfidence
    ? null
    : verdict;
}

/** JSON with object keys sorted and undefined values dropped, for order-independent comparison. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

function samePricing(a: PricingRule[], b: PricingRule[]): boolean {
  const normalize = (rules: PricingRule[]) =>
    JSON.stringify(
      rules.map((rule) =>
        Object.fromEntries(
          Object.entries(rule)
            .filter(([, value]) => value !== undefined)
            .sort(([x], [y]) => x.localeCompare(y)),
        ),
      ),
    );
  return normalize(a) === normalize(b);
}

/**
 * Tops the agent-owner persona's wallet back up to the floor with demo money, so judges who skip
 * the PayPal top-up still see the shared research agent pay. Idempotent under concurrency: the
 * posting is keyed by the number of entries the wallet has had, so two calls that saw the same
 * wallet add the money once, and any later charge allows the next top-up.
 */
export async function ensureDemoWalletFloor(
  db: Db,
  input: { userId: string; floorCents?: number },
): Promise<{ addedCents: number }> {
  const floorMicros = centsToMicros(input.floorCents ?? DEMO_WALLET_FLOOR_CENTS);
  const wallet = Accounts.wallet(input.userId);
  const [entries] = await db
    .select({ n: count() })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, wallet));
  const balance = await walletBalanceMicros(db, input.userId);
  if (balance >= floorMicros) return { addedCents: 0 };
  const cents = Math.ceil((floorMicros - balance) / centsToMicros(1));
  const amount = centsToMicros(cents);
  const posted = await postTransaction(db, {
    kind: "seed",
    idempotencyKey: `demo-wallet-floor:${input.userId}:${entries?.n ?? 0}`,
    memo: "Demo balance so the next judge's research agent can pay",
    entries: [
      { accountId: wallet, amountMicros: amount },
      { accountId: Accounts.paypalClearing, amountMicros: -amount },
    ],
  });
  return { addedCents: posted.created ? cents : 0 };
}
