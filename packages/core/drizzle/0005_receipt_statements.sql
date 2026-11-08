CREATE TABLE "receipt_statements" (
	"receipt_id" text NOT NULL,
	"kind" text NOT NULL,
	"jws" text NOT NULL,
	"kid" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_statements_pk" PRIMARY KEY("receipt_id","kind"),
	CONSTRAINT "receipt_statements_kind_ck" CHECK ("receipt_statements"."kind" in ('payment', 'delivery', 'refund'))
);
--> statement-breakpoint
ALTER TABLE "receipt_statements" ADD CONSTRAINT "receipt_statements_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;