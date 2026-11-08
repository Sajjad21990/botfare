ALTER TABLE "receipts" ADD COLUMN "detection_signal" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "detection" jsonb DEFAULT '{"level":"known-bots","edge":{"cloudflare":{"enabled":false,"scoreHeader":"cf-bot-score","verifiedBotHeader":"cf-verified-bot","maxBotScore":29},"akamai":{"enabled":false,"header":"akamai-bot"}},"turnstileSiteKey":null}'::jsonb NOT NULL;--> statement-breakpoint
-- Existing sites keep the behaviour they had: the old switch on charges known AI crawlers
-- ("known-bots", the column default); off charges only self-identified agents ("off").
-- New sites get the default from the column.
UPDATE "sites" SET "detection" = jsonb_set("detection", '{level}', '"off"') WHERE "charge_known_bots" = false;
