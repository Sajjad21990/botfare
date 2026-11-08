/**
 * Postgres schema for BotFare. Text primary keys come from `newId()` in @botfare/contracts.
 * Money in the ledger is integer micro-dollars (1 USD = 1,000,000); money on the wire and in
 * PayPal records is integer cents.
 */
import { DEFAULT_DETECTION, type DetectionConfig, type PricingRule } from "@botfare/contracts";
import {
  type DeclaredOffer,
  type DeclineCategory,
  type DisputeReason,
  type DisputeVerdict,
  disputeStatusSchema,
} from "@botfare/contracts/fare";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { JWK } from "jose";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const micros = (name: string) => bigint(name, { mode: "number" });

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  /** Where this publisher's earnings go; falls back to their first site's payout_email. */
  payoutEmail: text("payout_email"),
  createdAt: createdAt(),
});

export const sites = pgTable(
  "sites",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    origin: text("origin").notNull(),
    /** sha256 hex of the site secret; the secret itself is shown once and never stored. */
    secretHash: text("secret_hash").notNull(),
    pricing: jsonb("pricing").$type<PricingRule[]>().notNull().default([]),
    freePaths: jsonb("free_paths").$type<string[]>().notNull().default([]),
    /** Legacy switch, kept for older middleware; `detection.level` supersedes it. */
    chargeKnownBots: boolean("charge_known_bots").notNull().default(false),
    /** Agent detection settings (detectionConfigSchema), served to the middleware with the config. */
    detection: jsonb("detection").$type<DetectionConfig>().notNull().default(DEFAULT_DETECTION),
    payoutEmail: text("payout_email"),
    /** Changes on every save so the middleware can skip unchanged configs. */
    version: text("version").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sites_owner_idx").on(t.ownerUserId)],
);

export const agentKeys = pgTable(
  "agent_keys",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    publicJwk: jsonb("public_jwk").$type<JWK>().notNull(),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    perRequestMaxCents: integer("per_request_max_cents"),
    dailyCapCents: integer("daily_cap_cents"),
    /** null = the key may pay any site. */
    allowedSiteIds: jsonb("allowed_site_ids").$type<string[]>(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_keys_owner_idx").on(t.ownerUserId),
    check("agent_keys_status_ck", sql`${t.status} in ('active', 'revoked')`),
  ],
);

export const ledgerAccountKinds = ["wallet", "earnings", "platform", "external"] as const;
export type LedgerAccountKind = (typeof ledgerAccountKinds)[number];

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    /** `wallet:<userId>`, `earnings:<userId>`, `platform:fees`, `paypal:clearing`, `paypal:fees`. */
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ledgerAccountKinds }).notNull(),
    ownerUserId: text("owner_user_id").references(() => users.id),
    /** Cache of the sum of this account's entries; written only by postTransaction. */
    balanceMicros: micros("balance_micros").notNull().default(0),
  },
  (t) => [
    check(
      "ledger_accounts_kind_ck",
      sql`${t.kind} in ('wallet', 'earnings', 'platform', 'external')`,
    ),
    check(
      "ledger_accounts_non_negative_ck",
      sql`${t.kind} not in ('wallet', 'earnings') or ${t.balanceMicros} >= 0`,
    ),
  ],
);

export const ledgerTransactionKinds = [
  "topup",
  "seed",
  "charge",
  "refund",
  "payout",
  "payout_reversal",
] as const;
export type LedgerTransactionKind = (typeof ledgerTransactionKinds)[number];

export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ledgerTransactionKinds }).notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    memo: text("memo"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "ledger_transactions_kind_ck",
      sql`${t.kind} in ('topup', 'seed', 'charge', 'refund', 'payout', 'payout_reversal')`,
    ),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: serial("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: text("account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    amountMicros: micros("amount_micros").notNull(),
  },
  (t) => [
    index("ledger_entries_transaction_idx").on(t.transactionId),
    index("ledger_entries_account_idx").on(t.accountId),
  ],
);

export const receipts = pgTable(
  "receipts",
  {
    /** Also the x402 `transaction` returned by settle. */
    id: text("id").primaryKey(),
    agentKeyId: text("agent_key_id")
      .notNull()
      .references(() => agentKeys.id),
    /** Owner of the agent key, whose wallet paid. */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    /** Owner of the site, who earned. */
    publisherUserId: text("publisher_user_id")
      .notNull()
      .references(() => users.id),
    resourceUrl: text("resource_url"),
    amountCents: integer("amount_cents").notNull(),
    amountMicros: micros("amount_micros").notNull(),
    feeMicros: micros("fee_micros").notNull(),
    nonce: text("nonce").notNull(),
    status: text("status", { enum: ["settled", "refunded"] })
      .notNull()
      .default("settled"),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id),
    refundTransactionId: text("refund_transaction_id").references(() => ledgerTransactions.id),
    /**
     * Why the middleware treated the request as an agent (a detectionSignalSchema value), from the
     * payment requirements' `extra.botfareSignal`; null when absent or unknown.
     */
    detectionSignal: text("detection_signal"),
    /**
     * The offer as the publisher declared it at settle (`extra.botfareOffer`, declaredOfferSchema);
     * null when absent or invalid. Fare Court compares it with what was delivered.
     */
    declaredOffer: jsonb("declared_offer").$type<DeclaredOffer>(),
    /** Proof of delivery, attested once by the paid site: RFC 9530 `sha-256=:…:` of the body. */
    contentDigest: text("content_digest"),
    contentLength: integer("content_length"),
    contentType: text("content_type"),
    /** HTTP status the publisher delivered with. */
    deliveredStatus: integer("delivered_status"),
    attestedAt: timestamp("attested_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("receipts_agent_key_nonce_uq").on(t.agentKeyId, t.nonce),
    index("receipts_agent_key_created_idx").on(t.agentKeyId, t.createdAt),
    index("receipts_owner_created_idx").on(t.ownerUserId, t.createdAt),
    index("receipts_site_created_idx").on(t.siteId, t.createdAt),
    check("receipts_status_ck", sql`${t.status} in ('settled', 'refunded')`),
    check("receipts_amount_ck", sql`${t.amountCents} > 0`),
  ],
);

export const topups = pgTable(
  "topups",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    orderId: text("order_id").notNull(),
    captureId: text("capture_id").notNull().unique(),
    grossCents: integer("gross_cents").notNull(),
    feeCents: integer("fee_cents").notNull(),
    status: text("status").notNull(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id),
    createdAt: createdAt(),
  },
  (t) => [index("topups_owner_idx").on(t.ownerUserId), index("topups_order_idx").on(t.orderId)],
);

export const paypalOrderStatuses = ["created", "captured", "failed"] as const;
export type PayPalOrderStatus = (typeof paypalOrderStatuses)[number];

/** Binds a PayPal order (wallet top-up) to the user who created it. */
export const paypalOrders = pgTable(
  "paypal_orders",
  {
    orderId: text("order_id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    amountCents: integer("amount_cents").notNull(),
    status: text("status", { enum: paypalOrderStatuses }).notNull().default("created"),
    captureId: text("capture_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("paypal_orders_owner_idx").on(t.ownerUserId),
    check("paypal_orders_status_ck", sql`${t.status} in ('created', 'captured', 'failed')`),
    check("paypal_orders_amount_ck", sql`${t.amountCents} > 0`),
  ],
);

export const payoutStatuses = [
  "pending",
  "processing",
  "success",
  "failed",
  "returned",
  "unclaimed",
  "reversed",
] as const;
export type PayoutStatus = (typeof payoutStatuses)[number];

/**
 * One row per publisher payout item. `id` (po_…) is also the PayPal `sender_item_id`;
 * `batchKey` is the PayPal `sender_batch_id`, shared by every item of one daily run.
 */
export const payouts = pgTable(
  "payouts",
  {
    id: text("id").primaryKey(),
    /**
     * PayPal `sender_batch_id`. PayPal refuses a second batch with the same ID for 30 days (400
     * USER_BUSINESS_ERROR linking the first batch), so retries reuse it and never pay twice.
     */
    batchKey: text("sender_batch_id").notNull(),
    publisherUserId: text("publisher_user_id")
      .notNull()
      .references(() => users.id),
    receiverEmail: text("receiver_email").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status", { enum: payoutStatuses }).notNull().default("pending"),
    paypalBatchId: text("paypal_batch_id"),
    paypalItemId: text("paypal_item_id"),
    /** PayPal's transaction ID for the item, once paid. */
    paypalTransactionId: text("paypal_transaction_id"),
    error: text("error"),
    /** Ledger posting that moved the earnings out (kind `payout`). */
    transactionId: text("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id),
    /** Ledger posting that returned them (kind `payout_reversal`), at most one. */
    reversalTransactionId: text("reversal_transaction_id").references(() => ledgerTransactions.id),
    /**
     * Ledger posting that took the earnings again (kind `payout`) because PayPal paid the item
     * after we had reversed it. At most one.
     */
    redebitTransactionId: text("redebit_transaction_id").references(() => ledgerTransactions.id),
    /** How many times the batch was sent to PayPal. Above 1 means a retry of the same batch. */
    submitAttempts: integer("submit_attempts").notNull().default(0),
    /**
     * Held while one caller sends the batch to PayPal, so "Withdraw now", "Refresh status" and the
     * cron never POST the same batch at the same time. Cleared when the call returns.
     */
    submitLockedUntil: timestamp("submit_locked_until", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("payouts_publisher_idx").on(t.publisherUserId),
    index("payouts_batch_key_idx").on(t.batchKey),
    index("payouts_paypal_item_idx").on(t.paypalItemId),
    check(
      "payouts_status_ck",
      sql`${t.status} in ('pending', 'processing', 'success', 'failed', 'returned', 'unclaimed', 'reversed')`,
    ),
    check("payouts_amount_ck", sql`${t.amountCents} > 0`),
  ],
);

export const webhookEventStatuses = ["received", "processed", "ignored", "failed"] as const;
export type WebhookEventStatus = (typeof webhookEventStatuses)[number];

/** Every PayPal webhook delivery we accepted, deduped by PayPal's event ID. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: serial("id").primaryKey(),
    paypalEventId: text("paypal_event_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    resourceId: text("resource_id"),
    payload: jsonb("payload").$type<unknown>().notNull(),
    status: text("status", { enum: webhookEventStatuses }).notNull().default("received"),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("webhook_events_type_idx").on(t.eventType),
    check(
      "webhook_events_status_ck",
      sql`${t.status} in ('received', 'processed', 'ignored', 'failed')`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Fare Court

/**
 * Dispute states: the contract's DisputeStatus plus `open` (filed, waiting for the AI verdict).
 * Open and pending_publisher disputes are "open" for the one-open-dispute-per-receipt rule.
 */
export const disputeRowStatuses = ["open", ...disputeStatusSchema.options] as const;
export type DisputeRowStatus = (typeof disputeRowStatuses)[number];
export const disputeDeciders = ["ai", "publisher", "system"] as const;
export type DisputeDecider = (typeof disputeDeciders)[number];

export const disputes = pgTable(
  "disputes",
  {
    id: text("id").primaryKey(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => receipts.id),
    agentKeyId: text("agent_key_id")
      .notNull()
      .references(() => agentKeys.id),
    /** Agent owner whose wallet paid (and gets any refund). */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    publisherUserId: text("publisher_user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").$type<DisputeReason>().notNull(),
    note: text("note"),
    /** The bytes the agent submitted hash to the attested Content-Digest. */
    contentDigestOk: boolean("content_digest_ok").notNull(),
    /** The start of the delivered text (about 4 KB), for the publisher's review. */
    deliveredExcerpt: text("delivered_excerpt"),
    /** The AI judge's zod-validated verdict; null until it ran (or when it could not). */
    verdict: jsonb("verdict").$type<DisputeVerdict>(),
    status: text("status", { enum: disputeRowStatuses }).notNull().default("open"),
    /** False when the key's dispute rate needs publisher review: AI verdicts cannot refund. */
    autoAllowed: boolean("auto_allowed").notNull().default(true),
    /** Human-readable state, e.g. why a refund could not be made. */
    message: text("message"),
    refundedCents: integer("refunded_cents").notNull().default(0),
    refundTransactionId: text("refund_transaction_id").references(() => ledgerTransactions.id),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by", { enum: disputeDeciders }),
  },
  (t) => [
    uniqueIndex("disputes_receipt_open_uq")
      .on(t.receiptId)
      .where(sql`${t.status} in ('open', 'pending_publisher')`),
    index("disputes_receipt_idx").on(t.receiptId),
    index("disputes_agent_key_created_idx").on(t.agentKeyId, t.createdAt),
    index("disputes_owner_created_idx").on(t.ownerUserId, t.createdAt),
    index("disputes_publisher_created_idx").on(t.publisherUserId, t.createdAt),
    index("disputes_site_created_idx").on(t.siteId, t.createdAt),
    check(
      "disputes_status_ck",
      sql`${t.status} in ('open', 'refunded', 'denied', 'pending_publisher', 'rejected_by_publisher', 'invalid')`,
    ),
    check(
      "disputes_decided_by_ck",
      sql`${t.decidedBy} is null or ${t.decidedBy} in ('ai', 'publisher', 'system')`,
    ),
    check("disputes_refunded_ck", sql`${t.refundedCents} >= 0`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Fare Advisor signals (no personal data: paths, prices and agent-written reasons only)

/** "Offer shown" events (402s) reported by the publisher middleware. */
export const offerEvents = pgTable(
  "offer_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    path: text("path").notNull(),
    method: text("method").notNull(),
    priceCents: integer("price_cents").notNull(),
    signal: text("signal"),
    /** When the middleware showed the offer. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("offer_events_site_at_idx").on(t.siteId, t.at),
    index("offer_events_site_path_at_idx").on(t.siteId, t.path, t.at),
  ],
);

/** An agent saw an offer and said why it did not buy. One per key, URL and UTC day. */
export const offerDeclines = pgTable(
  "offer_declines",
  {
    id: serial("id").primaryKey(),
    agentKeyId: text("agent_key_id")
      .notNull()
      .references(() => agentKeys.id),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    url: text("url").notNull(),
    path: text("path").notNull(),
    priceCents: integer("price_cents").notNull(),
    category: text("category").$type<DeclineCategory>().notNull(),
    reason: text("reason").notNull(),
    /** UTC day of the decline, for the once-per-key-URL-day rule. */
    day: date("day", { mode: "string" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("offer_declines_key_url_day_uq").on(t.agentKeyId, t.url, t.day),
    index("offer_declines_site_created_idx").on(t.siteId, t.createdAt),
  ],
);

/** A paid read that an agent's answer actually used ("citations are the new clicks"). */
export const citations = pgTable(
  "citations",
  {
    id: serial("id").primaryKey(),
    /** Client-generated answer ID; a new report with the same ID replaces the old one. */
    answerId: text("answer_id").notNull(),
    agentKeyId: text("agent_key_id")
      .notNull()
      .references(() => agentKeys.id),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => receipts.id),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    claim: text("claim").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("citations_answer_receipt_uq").on(t.answerId, t.receiptId),
    index("citations_site_created_idx").on(t.siteId, t.createdAt),
    index("citations_receipt_idx").on(t.receiptId),
  ],
);

export type User = typeof users.$inferSelect;
export type Site = typeof sites.$inferSelect;
export type AgentKey = typeof agentKeys.$inferSelect;
export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type LedgerTransaction = typeof ledgerTransactions.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type Receipt = typeof receipts.$inferSelect;
export type TopUp = typeof topups.$inferSelect;
export type Payout = typeof payouts.$inferSelect;
export type PayPalOrder = typeof paypalOrders.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type Dispute = typeof disputes.$inferSelect;
export type OfferEvent = typeof offerEvents.$inferSelect;
export type OfferDecline = typeof offerDeclines.$inferSelect;
export type Citation = typeof citations.$inferSelect;
