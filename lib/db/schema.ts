import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  unique,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { SOURCE_TYPES } from "@/lib/schemas/source";

export const tracks = pgTable("tracks", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  instructions: text("instructions"),
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
  type: text("type", { enum: SOURCE_TYPES }).notNull(),
  url: text("url").notNull(),
  title: text("title"),
});

export const outlineItems = pgTable(
  "outline_items",
  {
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
  },
  (t) => [unique().on(t.trackId, t.dayIndex)],
);

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

export const GENERATION_CALLERS = ["outline", "outline_revision", "daily", "judge"] as const;
export type GenerationCaller = (typeof GENERATION_CALLERS)[number];

/** One row per model call. Written by the app's server actions; read by cost reporting and the eval harness. */
export const generationLog = pgTable("generation_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  caller: text("caller", { enum: GENERATION_CALLERS }).notNull(),
  model: text("model").notNull(),
  effort: text("effort"), // null until the effort axis is wired (W4 Task 4 / W5)
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"), // usage.inputTokenDetails.cacheReadTokens
  reasoningTokens: integer("reasoning_tokens"), // usage.outputTokenDetails.reasoningTokens
  costUsd: doublePrecision("cost_usd").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  trackId: uuid("track_id"), // nullable: draft outlines have no track yet
  userId: text("user_id"), // nullable: eval-harness rows have no user
  createdAt: timestamp("created_at").notNull().defaultNow(),
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
export type GenerationLog = typeof generationLog.$inferSelect;
export type NewGenerationLog = typeof generationLog.$inferInsert;

export const outlineItemsRelations = relations(outlineItems, ({ one }) => ({
  track: one(tracks, { fields: [outlineItems.trackId], references: [tracks.id] }),
}));
