CREATE TABLE "agent_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"per_request_max_cents" integer,
	"daily_cap_cents" integer,
	"allowed_site_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_keys_status_ck" CHECK ("agent_keys"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" text,
	"balance_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ledger_accounts_kind_ck" CHECK ("ledger_accounts"."kind" in ('wallet', 'earnings', 'platform', 'external')),
	CONSTRAINT "ledger_accounts_non_negative_ck" CHECK ("ledger_accounts"."kind" not in ('wallet', 'earnings') or "ledger_accounts"."balance_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"account_id" text NOT NULL,
	"amount_micros" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ledger_transactions_kind_ck" CHECK ("ledger_transactions"."kind" in ('topup', 'seed', 'charge', 'refund', 'payout', 'payout_reversal'))
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"publisher_user_id" text NOT NULL,
	"sender_batch_id" text NOT NULL,
	"paypal_batch_id" text,
	"amount_cents" integer NOT NULL,
	"status" text NOT NULL,
	"transaction_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_sender_batch_id_unique" UNIQUE("sender_batch_id")
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_key_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"publisher_user_id" text NOT NULL,
	"resource_url" text,
	"amount_cents" integer NOT NULL,
	"amount_micros" bigint NOT NULL,
	"fee_micros" bigint NOT NULL,
	"nonce" text NOT NULL,
	"status" text DEFAULT 'settled' NOT NULL,
	"transaction_id" text NOT NULL,
	"refund_transaction_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_status_ck" CHECK ("receipts"."status" in ('settled', 'refunded')),
	CONSTRAINT "receipts_amount_ck" CHECK ("receipts"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"secret_hash" text NOT NULL,
	"pricing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"free_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"charge_known_bots" boolean DEFAULT false NOT NULL,
	"payout_email" text,
	"version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topups" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"order_id" text NOT NULL,
	"capture_id" text NOT NULL,
	"gross_cents" integer NOT NULL,
	"fee_cents" integer NOT NULL,
	"status" text NOT NULL,
	"transaction_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topups_capture_id_unique" UNIQUE("capture_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_publisher_user_id_users_id_fk" FOREIGN KEY ("publisher_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_publisher_user_id_users_id_fk" FOREIGN KEY ("publisher_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_refund_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("refund_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_keys_owner_idx" ON "agent_keys" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "payouts_publisher_idx" ON "payouts" USING btree ("publisher_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_agent_key_nonce_uq" ON "receipts" USING btree ("agent_key_id","nonce");--> statement-breakpoint
CREATE INDEX "receipts_agent_key_created_idx" ON "receipts" USING btree ("agent_key_id","created_at");--> statement-breakpoint
CREATE INDEX "receipts_owner_created_idx" ON "receipts" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "receipts_site_created_idx" ON "receipts" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "sites_owner_idx" ON "sites" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "topups_owner_idx" ON "topups" USING btree ("owner_user_id");