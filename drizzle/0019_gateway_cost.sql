ALTER TABLE "generation_log" ALTER COLUMN "cost_usd" DROP NOT NULL;--> statement-breakpoint
-- A call on the user's own key has no gateway charge: the estimates logged for them before go.
UPDATE "generation_log" SET "cost_usd" = NULL WHERE "key_owner" = 'user';
