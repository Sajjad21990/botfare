/**
 * Postgres schema for BotFare. Text primary keys come from `newId()` in @botfare/contracts.
 * Money in the ledger is integer micro-dollars (1 USD = 1,000,000); money on the wire and in
 * PayPal records is integer cents.
 */
import type { PricingRule } from "@botfare/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
    chargeKnownBots: boolean("charge_known_bots").notNull().default(false),
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
  (t) => [index("topups_owner_idx").on(t.ownerUserId)],
);

export const payouts = pgTable(
  "payouts",
  {
    id: text("id").primaryKey(),
    publisherUserId: text("publisher_user_id")
      .notNull()
      .references(() => users.id),
    senderBatchId: text("sender_batch_id").notNull().unique(),
    paypalBatchId: text("paypal_batch_id"),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("payouts_publisher_idx").on(t.publisherUserId)],
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
