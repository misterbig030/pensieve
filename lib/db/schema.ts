import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const tracks = pgTable("tracks", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status", { enum: ["active", "completed", "archived"] })
    .notNull()
    .default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  trackId: uuid("track_id")
    .notNull()
    .references(() => tracks.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["link", "youtube"] }).notNull(),
  url: text("url").notNull(),
  title: text("title"),
});

export const outlineItems = pgTable("outline_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  trackId: uuid("track_id")
    .notNull()
    .references(() => tracks.id, { onDelete: "cascade" }),
  dayIndex: integer("day_index").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: text("status", {
    enum: ["pending", "generated", "completed"],
  })
    .notNull()
    .default("pending"),
});

export const dailyContent = pgTable("daily_content", {
  id: uuid("id").primaryKey().defaultRandom(),
  outlineItemId: uuid("outline_item_id")
    .notNull()
    .unique()
    .references(() => outlineItems.id, { onDelete: "cascade" }),
  contentMarkdown: text("content_markdown").notNull(),
  citations: jsonb("citations").notNull().default([]),
  model: text("model").notNull(),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
});

export const checkIns = pgTable("check_ins", {
  id: uuid("id").primaryKey().defaultRandom(),
  outlineItemId: uuid("outline_item_id")
    .notNull()
    .references(() => outlineItems.id, { onDelete: "cascade" }),
  completedAt: timestamp("completed_at").notNull().defaultNow(),
});

export type Track = typeof tracks.$inferSelect;
export type NewTrack = typeof tracks.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type OutlineItem = typeof outlineItems.$inferSelect;
export type NewOutlineItem = typeof outlineItems.$inferInsert;
export type DailyContent = typeof dailyContent.$inferSelect;
export type NewDailyContent = typeof dailyContent.$inferInsert;
export type CheckIn = typeof checkIns.$inferSelect;

export const outlineItemsRelations = relations(outlineItems, ({ one }) => ({
  track: one(tracks, { fields: [outlineItems.trackId], references: [tracks.id] }),
}));
