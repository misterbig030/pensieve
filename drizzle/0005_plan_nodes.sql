CREATE TABLE "plan_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"parent_id" uuid,
	"position" integer NOT NULL,
	"level" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"len" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"budget_hours" integer,
	"manual_split" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_ins" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "check_ins" ADD COLUMN "hours" double precision;--> statement-breakpoint
ALTER TABLE "daily_content" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "granularity" text DEFAULT 'day' NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_parent_id_plan_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_nodes_track_idx" ON "plan_nodes" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "plan_nodes_parent_idx" ON "plan_nodes" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_node_id_plan_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_content" ADD CONSTRAINT "daily_content_node_id_plan_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_content" ADD CONSTRAINT "daily_content_node_id_unique" UNIQUE("node_id");--> statement-breakpoint
-- Data migration: every outline item becomes a root-level day leaf with the same id, so content and check-ins carry over.
INSERT INTO "plan_nodes" ("id", "track_id", "parent_id", "position", "level", "title", "summary", "len", "status")
SELECT "id", "track_id", NULL, "day_index" - 1, 'day', "title", "summary", 1, "status" FROM "outline_items";--> statement-breakpoint
UPDATE "daily_content" SET "node_id" = "outline_item_id";--> statement-breakpoint
UPDATE "check_ins" SET "node_id" = "outline_item_id";
