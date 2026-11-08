CREATE TABLE "paypal_orders" (
	"order_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"capture_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_orders_status_ck" CHECK ("paypal_orders"."status" in ('created', 'captured', 'failed')),
	CONSTRAINT "paypal_orders_amount_ck" CHECK ("paypal_orders"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"paypal_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_events_paypal_event_id_unique" UNIQUE("paypal_event_id"),
	CONSTRAINT "webhook_events_status_ck" CHECK ("webhook_events"."status" in ('received', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_sender_batch_id_unique";--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "receiver_email" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "paypal_item_id" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "paypal_transaction_id" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "reversal_transaction_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "payout_email" text;--> statement-breakpoint
ALTER TABLE "paypal_orders" ADD CONSTRAINT "paypal_orders_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paypal_orders_owner_idx" ON "paypal_orders" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "webhook_events_type_idx" ON "webhook_events" USING btree ("event_type");--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_reversal_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("reversal_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payouts_batch_key_idx" ON "payouts" USING btree ("sender_batch_id");--> statement-breakpoint
CREATE INDEX "payouts_paypal_item_idx" ON "payouts" USING btree ("paypal_item_id");--> statement-breakpoint
CREATE INDEX "topups_order_idx" ON "topups" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_status_ck" CHECK ("payouts"."status" in ('pending', 'processing', 'success', 'failed', 'returned', 'unclaimed', 'reversed'));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_ck" CHECK ("payouts"."amount_cents" > 0);