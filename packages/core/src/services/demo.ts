/**
 * Judge mode keeps the shared demo working. Every judge who picks "Publisher" is the same user, so
 * each persona sign-in puts back what one judge could have changed for the next: Crema Notes'
 * prices, free paths and bot detection, the payout email, and enough earnings to try "Withdraw
 * now" again.
 */
import {
  CREMA_NOTES_DETECTION,
  DEMO_SITE_FREE_PATHS,
  DEMO_SITE_NAME,
  DEMO_SITE_PRICING,
  type PricingRule,
} from "@botfare/contracts";
import { centsToMicros } from "@botfare/x402-paypal";
import { count, desc, eq } from "drizzle-orm";
import { Accounts } from "../accounts";
import type { Db } from "../db";
import { earningsBalanceMicros, postTransaction, walletBalanceMicros } from "../ledger";
import { ledgerEntries, payouts, users } from "../schema";
import { setPayoutEmail } from "./payouts";
import { listSites, siteDetection, updateSiteDetection, updateSitePricing } from "./sites";

/** Earnings the publisher persona has at sign-in, so every judge can try a $1.00+ withdrawal. */
export const DEMO_EARNINGS_FLOOR_CENTS = 200;
/** Wallet balance the agent-owner persona keeps, so the shared research agent can always pay. */
export const DEMO_WALLET_FLOOR_CENTS = 500;

export interface DemoPublisherReset {
  /** Crema Notes sites whose prices were put back. */
  pricingReset: number;
  /** Crema Notes sites whose bot detection was put back. */
  detectionReset: number;
  payoutEmailReset: boolean;
  /** Demo earnings added this time (0 when the balance already reached the floor). */
  earningsAddedCents: number;
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
  for (const site of await listSites(db, input.userId)) {
    if (site.name !== DEMO_SITE_NAME) continue;
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

  const floorMicros = centsToMicros(input.earningsFloorCents ?? DEMO_EARNINGS_FLOOR_CENTS);
  const balance = await earningsBalanceMicros(db, input.userId);
  let earningsAddedCents = 0;
  if (balance < floorMicros) {
    const [latest] = await db
      .select({ id: payouts.id })
      .from(payouts)
      .where(eq(payouts.publisherUserId, input.userId))
      .orderBy(desc(payouts.createdAt), desc(payouts.id))
      .limit(1);
    // Whole cents, so the ledger stays in step with what a payout can send.
    const cents = Math.ceil((floorMicros - balance) / centsToMicros(1));
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

  return { pricingReset, detectionReset, payoutEmailReset, earningsAddedCents };
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
