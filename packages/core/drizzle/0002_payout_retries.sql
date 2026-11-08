ALTER TABLE "payouts" ADD COLUMN "redebit_transaction_id" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "submit_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "submit_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_redebit_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("redebit_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Every existing payout was sent to PayPal at least once (submitted right after it was reserved).
UPDATE "payouts" SET "submit_attempts" = 1;
