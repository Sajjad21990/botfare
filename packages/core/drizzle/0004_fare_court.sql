CREATE TABLE "citations" (
	"id" serial PRIMARY KEY NOT NULL,
	"answer_id" text NOT NULL,
	"agent_key_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"site_id" text NOT NULL,
	"claim" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"receipt_id" text NOT NULL,
	"agent_key_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"publisher_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"content_digest_ok" boolean NOT NULL,
	"delivered_excerpt" text,
	"verdict" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"auto_allowed" boolean DEFAULT true NOT NULL,
	"message" text,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"refund_transaction_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	CONSTRAINT "disputes_status_ck" CHECK ("disputes"."status" in ('open', 'refunded', 'denied', 'pending_publisher', 'rejected_by_publisher', 'invalid')),
	CONSTRAINT "disputes_decided_by_ck" CHECK ("disputes"."decided_by" is null or "disputes"."decided_by" in ('ai', 'publisher', 'system')),
	CONSTRAINT "disputes_refunded_ck" CHECK ("disputes"."refunded_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "offer_declines" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_key_id" text NOT NULL,
	"site_id" text NOT NULL,
	"url" text NOT NULL,
	"path" text NOT NULL,
	"price_cents" integer NOT NULL,
	"category" text NOT NULL,
	"reason" text NOT NULL,
	"day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"path" text NOT NULL,
	"method" text NOT NULL,
	"price_cents" integer NOT NULL,
	"signal" text,
	"at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "declared_offer" jsonb;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "content_digest" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "content_length" integer;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "delivered_status" integer;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "attested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_publisher_user_id_users_id_fk" FOREIGN KEY ("publisher_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_refund_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("refund_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_declines" ADD CONSTRAINT "offer_declines_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_declines" ADD CONSTRAINT "offer_declines_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "citations_answer_receipt_uq" ON "citations" USING btree ("answer_id","receipt_id");--> statement-breakpoint
CREATE INDEX "citations_site_created_idx" ON "citations" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "citations_receipt_idx" ON "citations" USING btree ("receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_receipt_open_uq" ON "disputes" USING btree ("receipt_id") WHERE "disputes"."status" in ('open', 'pending_publisher');--> statement-breakpoint
CREATE INDEX "disputes_receipt_idx" ON "disputes" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "disputes_agent_key_created_idx" ON "disputes" USING btree ("agent_key_id","created_at");--> statement-breakpoint
CREATE INDEX "disputes_owner_created_idx" ON "disputes" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "disputes_publisher_created_idx" ON "disputes" USING btree ("publisher_user_id","created_at");--> statement-breakpoint
CREATE INDEX "disputes_site_created_idx" ON "disputes" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_declines_key_url_day_uq" ON "offer_declines" USING btree ("agent_key_id","url","day");--> statement-breakpoint
CREATE INDEX "offer_declines_site_created_idx" ON "offer_declines" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "offer_events_site_at_idx" ON "offer_events" USING btree ("site_id","at");--> statement-breakpoint
CREATE INDEX "offer_events_site_path_at_idx" ON "offer_events" USING btree ("site_id","path","at");