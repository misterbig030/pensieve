ALTER TABLE "sources" ADD COLUMN "minutes" integer;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "minutes_basis" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "uses" text;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "hours_per_week" integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "split" jsonb;