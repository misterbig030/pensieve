ALTER TABLE "node_materials" DROP CONSTRAINT "node_materials_node_id_source_id_pk";--> statement-breakpoint
ALTER TABLE "node_materials" ADD COLUMN "chapter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "node_materials" ADD COLUMN "activity" text DEFAULT 'read' NOT NULL;--> statement-breakpoint
ALTER TABLE "node_materials" ADD CONSTRAINT "node_materials_node_id_source_id_chapter_pk" PRIMARY KEY("node_id","source_id","chapter");
