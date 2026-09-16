import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
  doublePrecision,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { SOURCE_TYPES } from "@/lib/schemas/source";

export const tracks = pgTable("tracks", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  instructions: text("instructions"),
  summary: text("summary"),
  /** Whether the finest planned unit is a day or a week. Resolved from the learner's Day/Week/Auto choice. */
  granularity: text("granularity", { enum: ["day", "week"] }).notNull().default("day"),
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

export const PLAN_LEVELS = ["month", "week", "day"] as const;
export const NODE_STATUSES = ["pending", "generated", "completed"] as const;

/**
 * The plan tree. A node with no children is a leaf and holds content and check-ins; a node with children is a
 * month or a week heading. Spans (`len`) partition the parent's span; day numbering is derived, never stored.
 */
export const planNodes = pgTable(
  "plan_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => planNodes.id, { onDelete: "cascade" }),
    /** 0-based order among siblings. */
    position: integer("position").notNull(),
    level: text("level", { enum: PLAN_LEVELS }).notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    /** Span in days. */
    len: integer("len").notNull().default(1),
    status: text("status", { enum: NODE_STATUSES }).notNull().default("pending"),
    /** Week leaves carry a time budget in hours. */
    budgetHours: integer("budget_hours"),
    /** True when the learner split a week leaf into days by hand. */
    manualSplit: boolean("manual_split").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("plan_nodes_track_idx").on(t.trackId), index("plan_nodes_parent_idx").on(t.parentId)],
);

export const dailyContent = pgTable("daily_content", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeId: uuid("node_id")
    .notNull()
    .unique()
    .references(() => planNodes.id, { onDelete: "cascade" }),
  contentMarkdown: text("content_markdown").notNull(),
  citations: jsonb("citations").notNull().default([]),
  model: text("model").notNull(),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
});

/** One row per check-in. A day leaf gets one when completed; a week leaf gets one per logged session (`hours`). */
export const checkIns = pgTable("check_ins", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeId: uuid("node_id")
    .notNull()
    .references(() => planNodes.id, { onDelete: "cascade" }),
  hours: doublePrecision("hours"),
  completedAt: timestamp("completed_at").notNull().defaultNow(),
});

export const GENERATION_CALLERS = ["outline", "outline_revision", "daily", "judge", "chat"] as const;
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
export type PlanNodeRow = typeof planNodes.$inferSelect;
export type NewPlanNodeRow = typeof planNodes.$inferInsert;
export type DailyContent = typeof dailyContent.$inferSelect;
export type NewDailyContent = typeof dailyContent.$inferInsert;
export type CheckIn = typeof checkIns.$inferSelect;
export type GenerationLog = typeof generationLog.$inferSelect;
export type NewGenerationLog = typeof generationLog.$inferInsert;

export const planNodesRelations = relations(planNodes, ({ one }) => ({
  track: one(tracks, { fields: [planNodes.trackId], references: [tracks.id] }),
}));
