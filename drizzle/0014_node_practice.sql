CREATE TABLE "node_practice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"role" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"format" text NOT NULL,
	"source_id" uuid,
	"task" text DEFAULT '' NOT NULL,
	"done" text,
	"note" text,
	"minutes" integer,
	"generated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_practice" ADD CONSTRAINT "node_practice_node_id_plan_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_practice" ADD CONSTRAINT "node_practice_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_practice_node_idx" ON "node_practice" USING btree ("node_id");