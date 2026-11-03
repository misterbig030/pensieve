ALTER TABLE "plan_nodes" ADD COLUMN "time" jsonb;--> statement-breakpoint
ALTER TABLE "plan_nodes" ADD COLUMN "problems" jsonb;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "problems" jsonb;