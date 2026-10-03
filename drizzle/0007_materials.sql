CREATE TABLE "node_materials" (
	"node_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"role" text NOT NULL,
	"tier" text,
	"minutes" integer,
	"note" text,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "node_materials_node_id_source_id_pk" PRIMARY KEY("node_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "origin" text DEFAULT 'learner' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "kind" text DEFAULT 'note' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "backbone" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "author" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "year" integer;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "why" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "fetched_title" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "recommended_by" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_materials" ADD CONSTRAINT "node_materials_node_id_plan_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_materials" ADD CONSTRAINT "node_materials_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_materials_source_idx" ON "node_materials" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_one_backbone_idx" ON "sources" USING btree ("track_id") WHERE "sources"."backbone";--> statement-breakpoint
-- Data migration: existing sources are the learner's own (the column default). Derive a display kind from their type and keep their order.
UPDATE "sources" SET "kind" = CASE
	WHEN "type" = 'youtube' THEN 'video'
	WHEN "type" = 'link' AND "url" ~* '^https?://(www\.)?(github\.com|gitlab\.com)/' THEN 'repo'
	WHEN "type" = 'link' AND "url" ~* '^https?://(www\.)?arxiv\.org/' THEN 'paper'
	WHEN "type" = 'link' THEN 'docs'
	ELSE 'note'
END;--> statement-breakpoint
UPDATE "sources" AS s SET "position" = r.rn - 1
FROM (SELECT "id", row_number() OVER (PARTITION BY "track_id" ORDER BY ctid) AS rn FROM "sources") AS r
WHERE s."id" = r."id";
