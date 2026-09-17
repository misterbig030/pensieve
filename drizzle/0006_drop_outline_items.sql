ALTER TABLE "check_ins" DROP CONSTRAINT "check_ins_outline_item_id_outline_items_id_fk";--> statement-breakpoint
ALTER TABLE "daily_content" DROP CONSTRAINT "daily_content_outline_item_id_outline_items_id_fk";--> statement-breakpoint
ALTER TABLE "daily_content" DROP CONSTRAINT "daily_content_outline_item_id_unique";--> statement-breakpoint
ALTER TABLE "check_ins" ALTER COLUMN "node_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_content" ALTER COLUMN "node_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "check_ins" DROP COLUMN "outline_item_id";--> statement-breakpoint
ALTER TABLE "daily_content" DROP COLUMN "outline_item_id";--> statement-breakpoint
DROP TABLE "outline_items" CASCADE;
