# Pensieve MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP of Pensieve — a personal AI-assisted daily learning check-in app, starting with the "Senior SWE Interview / System Design" vertical but architected to support any topic.

**Architecture:** Next.js App Router on Vercel, Postgres (Neon) via Drizzle ORM, Clerk auth, Vercel AI Gateway for model calls (plain `"provider/model"` strings, user-selectable per generation). Outline drafts are generated client-visible but not persisted until the user confirms; daily teaching content is generated on demand and cached in the database.

**Tech Stack:** Next.js 15 (App Router, TypeScript), Drizzle ORM, `@neondatabase/serverless`, Clerk (`@clerk/nextjs`), Vercel AI SDK (`ai` package) via AI Gateway, Zod, shadcn/ui, Tailwind CSS, Vitest for unit tests.

## Global Constraints

- All business tables carry a `userId` (directly or via `trackId`) — multi-tenant from day one, even though only one real user exists today.
- Model calls always go through `"provider/model"` string identifiers resolved by the AI Gateway — never hardcode a provider SDK.
- Outline drafts (both initial creation and mid-course revision) are never persisted until the user explicitly confirms — draft state lives only in the browser/request, never in the database.
- Revising an outline only ever replaces `OutlineItem`s that are not `completed`; completed items and their `DailyContent`/`CheckIn` history are immutable.
- YouTube sources are embedded as link cards only — no transcript extraction in this plan (explicitly out of scope).
- No quiz/flashcard verification in this plan — check-in is a manual "mark complete" action.

---

## File Structure

```
lib/
  db/
    schema.ts        # Drizzle table definitions
    client.ts         # Drizzle client (Neon serverless driver)
    queries.ts         # Reusable query helpers (getTracksForUser, getTrackDetail, etc.)
  ai/
    models.ts          # AVAILABLE_MODELS constant + AiModelId type
    outline.ts          # buildOutlinePrompt (pure) + generateOutlineDraft (calls the model)
    dailyContent.ts     # buildDailyContentPrompt (pure) + generateDailyContent (calls the model)
  schemas/
    outline.ts          # Zod schema for the outline draft object
    dailyContent.ts     # Zod schema for the daily content object
  outlineRevision.ts    # Pure function: compute which OutlineItems survive vs get replaced
  streak.ts             # Pure function: compute streak length from check-in dates
app/
  layout.tsx             # Root layout, wraps children in <ClerkProvider>
  page.tsx                # Redirects to /dashboard
  dashboard/
    page.tsx              # Track list + streaks
  tracks/
    new/
      page.tsx             # Track creation form + draft confirm UI (client component)
      actions.ts            # 'use server': generateOutlineDraftAction, confirmTrackAction
    [id]/
      page.tsx              # Outline overview + "adjust plan" entry
      actions.ts             # 'use server': reviseOutlineDraftAction, confirmRevisionAction, markCompleteAction
      adjust/
        page.tsx              # Adjust-plan draft confirm UI (client component)
      day/
        [dayIndex]/
          page.tsx              # Daily content page
          actions.ts             # 'use server': generateDailyContentAction
middleware.ts             # Clerk middleware protecting all routes except sign-in/sign-up
drizzle.config.ts
```

Rationale: pure, testable logic (`streak.ts`, `outlineRevision.ts`, prompt builders in `ai/`, Zod schemas) is separated from the thin `'use server'` action files that perform I/O (DB writes, model calls) so business logic can be unit tested without mocking the database or the network.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: a running Next.js dev server at `localhost:3000`, `npm test` running Vitest.

- [ ] **Step 1: Scaffold the Next.js app**

```bash
npx create-next-app@latest . --typescript --tailwind --app --eslint --src-dir=false --import-alias "@/*" --use-npm --yes
```

- [ ] **Step 2: Install core dependencies**

```bash
npm install drizzle-orm @neondatabase/serverless ai @ai-sdk/gateway zod @clerk/nextjs
npm install -D drizzle-kit vitest @vitejs/plugin-react
```

- [ ] **Step 3: Add shadcn/ui**

```bash
npx shadcn@latest init --yes
npx shadcn@latest add button input textarea select card badge progress
```

- [ ] **Step 4: Configure Vitest**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
```

Add to `package.json` `scripts`: `"test": "vitest run"`.

- [ ] **Step 5: Verify the dev server and test runner both work**

Run: `npm run dev` — visit `localhost:3000`, confirm the default Next.js page renders. Stop the server.
Run: `npm test` — expect "no test files found" (not an error) since no tests exist yet.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with Tailwind, shadcn/ui, Vitest"
```

---

### Task 2: Database schema (Drizzle)

**Files:**
- Create: `lib/db/schema.ts`
- Create: `lib/db/client.ts`
- Create: `drizzle.config.ts`

**Interfaces:**
- Produces: exported Drizzle tables `tracks`, `sources`, `outlineItems`, `dailyContent`, `checkIns`, each with inferred `typeof table.$inferSelect` / `$inferInsert` types; exported `db` client from `lib/db/client.ts`.

- [ ] **Step 1: Provision Neon Postgres via Vercel Marketplace**

Run: `vercel link` (if not already linked), then `vercel integration add neon` (or add via the Vercel dashboard Marketplace tab if the CLI prompts interactively). Confirm `DATABASE_URL` appears in `vercel env ls`, then pull it locally:

```bash
vercel env pull .env.local
```

Verify `.env.local` contains a `DATABASE_URL` value.

- [ ] **Step 2: Write the schema**

Create `lib/db/schema.ts`:

```typescript
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

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
```

- [ ] **Step 2: Write the Drizzle client**

Create `lib/db/client.ts`:

```typescript
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });
```

- [ ] **Step 3: Write the Drizzle Kit config**

Create `drizzle.config.ts`:

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 4: Generate and apply the migration**

```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

Verify: run `npx drizzle-kit studio`, confirm all five tables (`tracks`, `sources`, `outline_items`, `daily_content`, `check_ins`) exist with the expected columns. Stop the studio process.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Drizzle schema for tracks, sources, outline items, daily content, check-ins"
```

---

### Task 3: Clerk authentication

**Files:**
- Modify: `app/layout.tsx`
- Create: `middleware.ts`
- Create: `app/sign-in/[[...sign-in]]/page.tsx`
- Create: `app/sign-up/[[...sign-up]]/page.tsx`

**Interfaces:**
- Produces: every route under `app/` (except sign-in/sign-up) requires an authenticated Clerk session; `auth()` from `@clerk/nextjs/server` is available in every server action/page to get `userId`.

- [ ] **Step 1: Provision Clerk via Vercel Marketplace and pull env vars**

```bash
vercel integration add clerk
vercel env pull .env.local
```

Verify `.env.local` contains `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.

- [ ] **Step 2: Wrap the root layout in `ClerkProvider`**

Modify `app/layout.tsx`:

```typescript
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
```

- [ ] **Step 3: Add Clerk middleware**

Create `middleware.ts`:

```typescript
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
```

- [ ] **Step 4: Add sign-in and sign-up pages**

Create `app/sign-in/[[...sign-in]]/page.tsx`:

```typescript
import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <SignIn />
    </div>
  );
}
```

Create `app/sign-up/[[...sign-up]]/page.tsx` with the equivalent `<SignUp />` component.

- [ ] **Step 5: Verify manually**

Run `npm run dev`, visit `localhost:3000`. Confirm you're redirected to `/sign-in`. Sign up with a test account, confirm you land back on the app authenticated.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Clerk authentication and route protection"
```

---

### Task 4: Model selection constant

**Files:**
- Create: `lib/ai/models.ts`
- Test: `lib/ai/models.test.ts`

**Interfaces:**
- Produces: `AVAILABLE_MODELS: { id: string; label: string }[]`, `DEFAULT_OUTLINE_MODEL: string`, `DEFAULT_CONTENT_MODEL: string`, type `AiModelId = (typeof AVAILABLE_MODELS)[number]["id"]`.

- [ ] **Step 1: Write the failing test**

Create `lib/ai/models.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { AVAILABLE_MODELS, DEFAULT_OUTLINE_MODEL, DEFAULT_CONTENT_MODEL } from "./models";

describe("AVAILABLE_MODELS", () => {
  it("every model id matches the provider/model gateway format", () => {
    for (const model of AVAILABLE_MODELS) {
      expect(model.id).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
    }
  });

  it("defaults point at ids present in the list", () => {
    const ids = AVAILABLE_MODELS.map((m) => m.id);
    expect(ids).toContain(DEFAULT_OUTLINE_MODEL);
    expect(ids).toContain(DEFAULT_CONTENT_MODEL);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/ai/models.test.ts`
Expected: FAIL — `models.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `lib/ai/models.ts`:

```typescript
export const AVAILABLE_MODELS = [
  { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5 (快，便宜)" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5 (推荐，均衡)" },
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5 (最强，贵)" },
] as const;

export type AiModelId = (typeof AVAILABLE_MODELS)[number]["id"];

export const DEFAULT_OUTLINE_MODEL: AiModelId = "anthropic/claude-haiku-4-5";
export const DEFAULT_CONTENT_MODEL: AiModelId = "anthropic/claude-sonnet-5";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/ai/models.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/ai/models.ts lib/ai/models.test.ts
git commit -m "feat: add available AI model list and defaults"
```

---

### Task 5: Streak calculation (pure logic)

**Files:**
- Create: `lib/streak.ts`
- Test: `lib/streak.test.ts`

**Interfaces:**
- Produces: `computeStreak(completedDates: Date[], today?: Date): number` — returns the number of consecutive days (ending today or yesterday) that have at least one completion.

- [ ] **Step 1: Write the failing tests**

Create `lib/streak.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { computeStreak } from "./streak";

const day = (offsetFromToday: number, today: Date) => {
  const d = new Date(today);
  d.setDate(d.getDate() - offsetFromToday);
  return d;
};

describe("computeStreak", () => {
  const today = new Date("2026-08-07T12:00:00Z");

  it("returns 0 for no check-ins", () => {
    expect(computeStreak([], today)).toBe(0);
  });

  it("returns 1 when only today has a check-in", () => {
    expect(computeStreak([day(0, today)], today)).toBe(1);
  });

  it("counts consecutive days ending today", () => {
    const dates = [day(0, today), day(1, today), day(2, today)];
    expect(computeStreak(dates, today)).toBe(3);
  });

  it("still counts the streak if today has no check-in yet but yesterday does", () => {
    const dates = [day(1, today), day(2, today)];
    expect(computeStreak(dates, today)).toBe(2);
  });

  it("breaks the streak on a gap", () => {
    const dates = [day(0, today), day(1, today), day(3, today)];
    expect(computeStreak(dates, today)).toBe(2);
  });

  it("resets to 0 if the most recent check-in is more than 1 day ago", () => {
    const dates = [day(3, today), day(4, today)];
    expect(computeStreak(dates, today)).toBe(0);
  });

  it("de-duplicates multiple check-ins on the same day", () => {
    const d0 = day(0, today);
    const d0b = new Date(d0);
    d0b.setHours(d0b.getHours() + 2);
    expect(computeStreak([d0, d0b], today)).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- lib/streak.test.ts`
Expected: FAIL — `streak.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `lib/streak.ts`:

```typescript
function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function computeStreak(completedDates: Date[], today: Date = new Date()): number {
  if (completedDates.length === 0) return 0;

  const dayKeys = new Set(completedDates.map(toDayKey));
  const todayKey = toDayKey(today);

  const cursor = new Date(today);
  if (!dayKeys.has(todayKey)) {
    // No check-in today yet — the streak can still be "alive" if yesterday
    // has one; start counting from yesterday instead.
    cursor.setDate(cursor.getDate() - 1);
    if (!dayKeys.has(toDayKey(cursor))) {
      return 0;
    }
  }

  let streak = 0;
  while (dayKeys.has(toDayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- lib/streak.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/streak.ts lib/streak.test.ts
git commit -m "feat: add streak calculation logic"
```

---

### Task 6: Outline schema and revision logic (pure logic)

**Files:**
- Create: `lib/schemas/outline.ts`
- Create: `lib/outlineRevision.ts`
- Test: `lib/schemas/outline.test.ts`
- Test: `lib/outlineRevision.test.ts`

**Interfaces:**
- Produces:
  - `outlineDraftSchema: z.ZodType<{ items: { dayIndex: number; title: string; summary: string }[] }>` from `lib/schemas/outline.ts`.
  - `computeOutlineReplacement(existing: { dayIndex: number; status: "pending" | "generated" | "completed" }[], draftItems: { title: string; summary: string }[]): { dayIndex: number; title: string; summary: string }[]` from `lib/outlineRevision.ts` — reindexes `draftItems` to start right after the last completed `dayIndex` in `existing`.

- [ ] **Step 1: Write the failing schema test**

Create `lib/schemas/outline.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { outlineDraftSchema } from "./outline";

describe("outlineDraftSchema", () => {
  it("accepts a valid draft", () => {
    const result = outlineDraftSchema.safeParse({
      items: [
        { dayIndex: 1, title: "System design basics", summary: "Intro to scalability" },
        { dayIndex: 2, title: "Load balancing", summary: "L4 vs L7, algorithms" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an item missing a summary", () => {
    const result = outlineDraftSchema.safeParse({
      items: [{ dayIndex: 1, title: "System design basics" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty items array", () => {
    const result = outlineDraftSchema.safeParse({ items: [] });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/schemas/outline.test.ts`
Expected: FAIL — `outline.ts` doesn't exist yet.

- [ ] **Step 3: Write the schema implementation**

Create `lib/schemas/outline.ts`:

```typescript
import { z } from "zod";

export const outlineDraftItemSchema = z.object({
  dayIndex: z.number().int().positive(),
  title: z.string().min(1),
  summary: z.string().min(1),
});

export const outlineDraftSchema = z.object({
  items: z.array(outlineDraftItemSchema).min(1),
});

export type OutlineDraftItem = z.infer<typeof outlineDraftItemSchema>;
export type OutlineDraft = z.infer<typeof outlineDraftSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/schemas/outline.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing revision-logic tests**

Create `lib/outlineRevision.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { computeOutlineReplacement } from "./outlineRevision";

describe("computeOutlineReplacement", () => {
  it("starts new items right after the last completed dayIndex", () => {
    const existing = [
      { dayIndex: 1, status: "completed" as const },
      { dayIndex: 2, status: "completed" as const },
      { dayIndex: 3, status: "generated" as const },
      { dayIndex: 4, status: "pending" as const },
    ];
    const draftItems = [
      { title: "New day A", summary: "..." },
      { title: "New day B", summary: "..." },
    ];
    const result = computeOutlineReplacement(existing, draftItems);
    expect(result).toEqual([
      { dayIndex: 3, title: "New day A", summary: "..." },
      { dayIndex: 4, title: "New day B", summary: "..." },
    ]);
  });

  it("starts at dayIndex 1 when nothing is completed yet", () => {
    const existing = [
      { dayIndex: 1, status: "pending" as const },
      { dayIndex: 2, status: "pending" as const },
    ];
    const draftItems = [{ title: "Only day", summary: "..." }];
    const result = computeOutlineReplacement(existing, draftItems);
    expect(result).toEqual([{ dayIndex: 1, title: "Only day", summary: "..." }]);
  });

  it("handles every item being completed (no replacement slots, still appends after)", () => {
    const existing = [
      { dayIndex: 1, status: "completed" as const },
      { dayIndex: 2, status: "completed" as const },
    ];
    const draftItems = [{ title: "Extra day", summary: "..." }];
    const result = computeOutlineReplacement(existing, draftItems);
    expect(result).toEqual([{ dayIndex: 3, title: "Extra day", summary: "..." }]);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- lib/outlineRevision.test.ts`
Expected: FAIL — `outlineRevision.ts` doesn't exist yet.

- [ ] **Step 7: Write the revision-logic implementation**

Create `lib/outlineRevision.ts`:

```typescript
interface ExistingItem {
  dayIndex: number;
  status: "pending" | "generated" | "completed";
}

interface DraftItem {
  title: string;
  summary: string;
}

export interface ReindexedItem extends DraftItem {
  dayIndex: number;
}

export function computeOutlineReplacement(
  existing: ExistingItem[],
  draftItems: DraftItem[],
): ReindexedItem[] {
  const lastCompletedDayIndex = existing
    .filter((item) => item.status === "completed")
    .reduce((max, item) => Math.max(max, item.dayIndex), 0);

  return draftItems.map((item, index) => ({
    ...item,
    dayIndex: lastCompletedDayIndex + 1 + index,
  }));
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- lib/outlineRevision.test.ts lib/schemas/outline.test.ts`
Expected: PASS (all tests)

- [ ] **Step 9: Commit**

```bash
git add lib/schemas/outline.ts lib/schemas/outline.test.ts lib/outlineRevision.ts lib/outlineRevision.test.ts
git commit -m "feat: add outline draft schema and revision reindexing logic"
```

---

### Task 7: Outline generation (AI call) and prompt builder

**Files:**
- Create: `lib/ai/outline.ts`
- Test: `lib/ai/outline.test.ts`

**Interfaces:**
- Consumes: `outlineDraftSchema` from `lib/schemas/outline.ts` (Task 6); `AiModelId` from `lib/ai/models.ts` (Task 4).
- Produces:
  - `buildOutlinePrompt(input: { topic: string; periodDays?: number; sources: { url: string; title?: string }[]; existingDraft?: OutlineDraft; feedback?: string }): string` (pure, unit tested).
  - `generateOutlineDraft(input: { topic: string; periodDays?: number; sources: { url: string; title?: string }[]; existingDraft?: OutlineDraft; feedback?: string; model: AiModelId }): Promise<OutlineDraft>` (calls the model — verified manually, not unit tested).

- [ ] **Step 1: Write the failing test for the pure prompt builder**

Create `lib/ai/outline.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildOutlinePrompt } from "./outline";

describe("buildOutlinePrompt", () => {
  it("includes the topic and period in a fresh-draft prompt", () => {
    const prompt = buildOutlinePrompt({
      topic: "System Design 面试准备",
      periodDays: 14,
      sources: [],
    });
    expect(prompt).toContain("System Design 面试准备");
    expect(prompt).toContain("14");
  });

  it("includes provided sources", () => {
    const prompt = buildOutlinePrompt({
      topic: "Stocks",
      sources: [{ url: "https://example.com/book", title: "Some Book" }],
    });
    expect(prompt).toContain("https://example.com/book");
    expect(prompt).toContain("Some Book");
  });

  it("includes the existing draft and feedback when revising", () => {
    const prompt = buildOutlinePrompt({
      topic: "System Design",
      sources: [],
      existingDraft: {
        items: [{ dayIndex: 1, title: "Old title", summary: "Old summary" }],
      },
      feedback: "Day 1 太难了，拆细一点",
    });
    expect(prompt).toContain("Old title");
    expect(prompt).toContain("太难了，拆细一点");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/ai/outline.test.ts`
Expected: FAIL — `outline.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `lib/ai/outline.ts`:

```typescript
import { generateObject } from "ai";
import { outlineDraftSchema, type OutlineDraft } from "@/lib/schemas/outline";
import type { AiModelId } from "./models";

interface BuildOutlinePromptInput {
  topic: string;
  periodDays?: number;
  sources: { url: string; title?: string }[];
  existingDraft?: OutlineDraft;
  feedback?: string;
}

export function buildOutlinePrompt(input: BuildOutlinePromptInput): string {
  const parts: string[] = [];

  parts.push(`You are designing a day-by-day self-study curriculum.`);
  parts.push(`Topic: ${input.topic}`);
  if (input.periodDays) {
    parts.push(`Target length: approximately ${input.periodDays} days.`);
  }
  if (input.sources.length > 0) {
    parts.push(`The learner provided these reference sources — use them to shape the curriculum's order and coverage where relevant:`);
    for (const source of input.sources) {
      parts.push(`- ${source.title ?? source.url} (${source.url})`);
    }
  }
  parts.push(
    `Decide for yourself whether this topic needs current, real-time information (e.g. recent news, evolving best practices) — if so, search the web before producing the outline. Otherwise rely on your own knowledge.`,
  );
  parts.push(`Order days from easiest/foundational to hardest/advanced.`);

  if (input.existingDraft) {
    parts.push(`Here is the current draft outline:`);
    for (const item of input.existingDraft.items) {
      parts.push(`Day ${item.dayIndex}: ${item.title} — ${item.summary}`);
    }
  }
  if (input.feedback) {
    parts.push(`The learner's feedback on the draft above: "${input.feedback}"`);
    parts.push(`Revise the draft to address this feedback. Return the complete revised list of days.`);
  }

  return parts.join("\n");
}

interface GenerateOutlineDraftInput extends BuildOutlinePromptInput {
  model: AiModelId;
}

export async function generateOutlineDraft(
  input: GenerateOutlineDraftInput,
): Promise<OutlineDraft> {
  const { object } = await generateObject({
    model: input.model,
    schema: outlineDraftSchema,
    prompt: buildOutlinePrompt(input),
  });
  return object;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/ai/outline.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/ai/outline.ts lib/ai/outline.test.ts
git commit -m "feat: add outline draft prompt builder and generation call"
```

---

### Task 8: Daily content schema and generation (AI call)

**Files:**
- Create: `lib/schemas/dailyContent.ts`
- Create: `lib/ai/dailyContent.ts`
- Test: `lib/schemas/dailyContent.test.ts`
- Test: `lib/ai/dailyContent.test.ts`

**Interfaces:**
- Consumes: `AiModelId` from `lib/ai/models.ts` (Task 4).
- Produces:
  - `dailyContentSchema` — `{ contentMarkdown: string; citations: { title: string; url: string }[] }`.
  - `buildDailyContentPrompt(input: { title: string; summary: string; sources: { url: string; title?: string; type: "link" | "youtube" }[] }): string` (pure).
  - `generateDailyContent(input: { title: string; summary: string; sources: {...}[]; model: AiModelId }): Promise<{ contentMarkdown: string; citations: {...}[] }>`.

- [ ] **Step 1: Write the failing schema test**

Create `lib/schemas/dailyContent.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { dailyContentSchema } from "./dailyContent";

describe("dailyContentSchema", () => {
  it("accepts valid content with citations", () => {
    const result = dailyContentSchema.safeParse({
      contentMarkdown: "# Load balancing\n\nContent here.",
      citations: [{ title: "AWS ELB docs", url: "https://aws.amazon.com/elb" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty citations array", () => {
    const result = dailyContentSchema.safeParse({
      contentMarkdown: "# Content",
      citations: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing contentMarkdown", () => {
    const result = dailyContentSchema.safeParse({ citations: [] });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/schemas/dailyContent.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the schema implementation**

Create `lib/schemas/dailyContent.ts`:

```typescript
import { z } from "zod";

export const dailyContentSchema = z.object({
  contentMarkdown: z.string().min(1),
  citations: z.array(
    z.object({
      title: z.string().min(1),
      url: z.string().url(),
    }),
  ),
});

export type DailyContentDraft = z.infer<typeof dailyContentSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/schemas/dailyContent.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing prompt-builder test**

Create `lib/ai/dailyContent.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildDailyContentPrompt } from "./dailyContent";

describe("buildDailyContentPrompt", () => {
  it("includes the day's title and summary", () => {
    const prompt = buildDailyContentPrompt({
      title: "Load balancing",
      summary: "L4 vs L7, algorithms",
      sources: [],
    });
    expect(prompt).toContain("Load balancing");
    expect(prompt).toContain("L4 vs L7, algorithms");
  });

  it("separates youtube sources from link sources and instructs embedding, not transcript extraction", () => {
    const prompt = buildDailyContentPrompt({
      title: "Caching",
      summary: "Cache strategies",
      sources: [
        { url: "https://youtube.com/watch?v=abc", type: "youtube", title: "Caching talk" },
        { url: "https://example.com/article", type: "link", title: "Caching article" },
      ],
    });
    expect(prompt).toContain("https://youtube.com/watch?v=abc");
    expect(prompt).toMatch(/embed|link card/i);
    expect(prompt).not.toMatch(/transcript/i);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- lib/ai/dailyContent.test.ts`
Expected: FAIL — `dailyContent.ts` doesn't exist yet.

- [ ] **Step 7: Write the implementation**

Create `lib/ai/dailyContent.ts`:

```typescript
import { generateObject } from "ai";
import { dailyContentSchema, type DailyContentDraft } from "@/lib/schemas/dailyContent";
import type { AiModelId } from "./models";

interface SourceInput {
  url: string;
  title?: string;
  type: "link" | "youtube";
}

interface BuildDailyContentPromptInput {
  title: string;
  summary: string;
  sources: SourceInput[];
}

export function buildDailyContentPrompt(input: BuildDailyContentPromptInput): string {
  const parts: string[] = [];

  parts.push(`Write today's lesson for a self-study curriculum.`);
  parts.push(`Day title: ${input.title}`);
  parts.push(`Day summary: ${input.summary}`);

  const linkSources = input.sources.filter((s) => s.type === "link");
  const youtubeSources = input.sources.filter((s) => s.type === "youtube");

  if (linkSources.length > 0) {
    parts.push(`Reference sources to draw from (cite them in the citations list when used):`);
    for (const s of linkSources) parts.push(`- ${s.title ?? s.url} (${s.url})`);
  }
  if (youtubeSources.length > 0) {
    parts.push(
      `The learner also provided these YouTube videos. Do not attempt to summarize their transcript — just mention them by title in the lesson text as a suggested video, since the app will render them as an embed/link card separately:`,
    );
    for (const s of youtubeSources) parts.push(`- ${s.title ?? s.url} (${s.url})`);
  }

  parts.push(
    `Decide for yourself whether this lesson needs current, real-time information — if so, search the web before writing. Otherwise rely on your own knowledge and the sources above.`,
  );
  parts.push(
    `Write the lesson body as markdown in the "contentMarkdown" field. List every external source you actually drew from in "citations" with its title and URL.`,
  );

  return parts.join("\n");
}

interface GenerateDailyContentInput extends BuildDailyContentPromptInput {
  model: AiModelId;
}

export async function generateDailyContent(
  input: GenerateDailyContentInput,
): Promise<DailyContentDraft> {
  const { object } = await generateObject({
    model: input.model,
    schema: dailyContentSchema,
    prompt: buildDailyContentPrompt(input),
  });
  return object;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- lib/ai/dailyContent.test.ts lib/schemas/dailyContent.test.ts`
Expected: PASS (all tests)

- [ ] **Step 9: Commit**

```bash
git add lib/schemas/dailyContent.ts lib/schemas/dailyContent.test.ts lib/ai/dailyContent.ts lib/ai/dailyContent.test.ts
git commit -m "feat: add daily content schema, prompt builder, and generation call"
```

---

### Task 9: Database query helpers

**Files:**
- Create: `lib/db/queries.ts`

**Interfaces:**
- Consumes: `db`, tables from `lib/db/schema.ts` (Task 2).
- Produces:
  - `getTracksForUser(userId: string)`
  - `getTrackDetail(trackId: string, userId: string)` (track + ordered outline items + sources, scoped to the owning user)
  - `getOutlineItemWithContent(outlineItemId: string, userId: string)` (outline item + its `daily_content` row if any, scoped via a join through `tracks.userId`)
  - `getCheckInDatesForUser(userId: string)` (all `completedAt` dates across the user's tracks, for streak calculation)
  - `createTrackWithOutline(input: { userId: string; title: string; description?: string; sources: {...}[]; items: {...}[] }): Promise<{ trackId: string }>` (transactional insert)
  - `replaceUnfinishedOutlineItems(trackId: string, userId: string, newItems: {...}[]): Promise<void>` (transactional delete + insert, scoped to non-completed items)
  - `upsertDailyContent(outlineItemId: string, content: { contentMarkdown: string; citations: unknown; model: string }): Promise<void>`
  - `markOutlineItemComplete(outlineItemId: string, userId: string): Promise<void>` (inserts a `check_ins` row, updates `outline_items.status`)

This task is DB-integration-only glue code with no independently testable pure logic beyond what Tasks 5–8 already cover — verify it manually against the real Neon database in Task 10/11/12 once the pages that call it exist, rather than with a standalone test here (mocking the Neon driver would only test the mock).

- [ ] **Step 1: Write the query helpers**

Create `lib/db/queries.ts`:

```typescript
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "./client";
import {
  tracks,
  sources,
  outlineItems,
  dailyContent,
  checkIns,
  type NewSource,
} from "./schema";

export async function getTracksForUser(userId: string) {
  return db.query.tracks.findMany({
    where: eq(tracks.userId, userId),
    orderBy: [asc(tracks.createdAt)],
  });
}

export async function getTrackDetail(trackId: string, userId: string) {
  const track = await db.query.tracks.findFirst({
    where: and(eq(tracks.id, trackId), eq(tracks.userId, userId)),
  });
  if (!track) return null;

  const items = await db.query.outlineItems.findMany({
    where: eq(outlineItems.trackId, trackId),
    orderBy: [asc(outlineItems.dayIndex)],
  });
  const trackSources = await db.query.sources.findMany({
    where: eq(sources.trackId, trackId),
  });

  return { track, items, sources: trackSources };
}

export async function getOutlineItemWithContent(outlineItemId: string, userId: string) {
  const item = await db.query.outlineItems.findFirst({
    where: eq(outlineItems.id, outlineItemId),
    with: { track: true },
  });
  if (!item || item.track.userId !== userId) return null;

  const content = await db.query.dailyContent.findFirst({
    where: eq(dailyContent.outlineItemId, outlineItemId),
  });

  return { item, content: content ?? null };
}

export async function getCheckInDatesForUser(userId: string): Promise<Date[]> {
  const rows = await db
    .select({ completedAt: checkIns.completedAt })
    .from(checkIns)
    .innerJoin(outlineItems, eq(checkIns.outlineItemId, outlineItems.id))
    .innerJoin(tracks, eq(outlineItems.trackId, tracks.id))
    .where(eq(tracks.userId, userId));
  return rows.map((r) => r.completedAt);
}

export async function createTrackWithOutline(input: {
  userId: string;
  title: string;
  description?: string;
  sources: Omit<NewSource, "id" | "trackId">[];
  items: { dayIndex: number; title: string; summary: string }[];
}): Promise<{ trackId: string }> {
  return db.transaction(async (tx) => {
    const [track] = await tx
      .insert(tracks)
      .values({
        userId: input.userId,
        title: input.title,
        description: input.description,
        status: "active",
      })
      .returning({ id: tracks.id });

    if (input.sources.length > 0) {
      await tx.insert(sources).values(
        input.sources.map((s) => ({ ...s, trackId: track.id })),
      );
    }

    await tx.insert(outlineItems).values(
      input.items.map((item) => ({ ...item, trackId: track.id })),
    );

    return { trackId: track.id };
  });
}

export async function replaceUnfinishedOutlineItems(
  trackId: string,
  userId: string,
  newItems: { dayIndex: number; title: string; summary: string }[],
): Promise<void> {
  const track = await db.query.tracks.findFirst({
    where: and(eq(tracks.id, trackId), eq(tracks.userId, userId)),
  });
  if (!track) throw new Error("Track not found for this user");

  await db.transaction(async (tx) => {
    const unfinished = await tx.query.outlineItems.findMany({
      where: and(eq(outlineItems.trackId, trackId), ne(outlineItems.status, "completed")),
    });
    const unfinishedIds = unfinished.map((i) => i.id);

    if (unfinishedIds.length > 0) {
      await tx.delete(dailyContent).where(inArray(dailyContent.outlineItemId, unfinishedIds));
      await tx.delete(outlineItems).where(inArray(outlineItems.id, unfinishedIds));
    }

    if (newItems.length > 0) {
      await tx.insert(outlineItems).values(
        newItems.map((item) => ({ ...item, trackId })),
      );
    }
  });
}

export async function upsertDailyContent(
  outlineItemId: string,
  content: { contentMarkdown: string; citations: unknown; model: string },
): Promise<void> {
  await db
    .insert(dailyContent)
    .values({ outlineItemId, ...content })
    .onConflictDoUpdate({
      target: dailyContent.outlineItemId,
      set: {
        contentMarkdown: content.contentMarkdown,
        citations: content.citations,
        model: content.model,
        generatedAt: new Date(),
      },
    });

  await db
    .update(outlineItems)
    .set({ status: "generated" })
    .where(and(eq(outlineItems.id, outlineItemId), ne(outlineItems.status, "completed")));
}

export async function markOutlineItemComplete(outlineItemId: string, userId: string): Promise<void> {
  const item = await db.query.outlineItems.findFirst({
    where: eq(outlineItems.id, outlineItemId),
    with: { track: true },
  });
  if (!item || item.track.userId !== userId) throw new Error("Outline item not found for this user");

  await db.transaction(async (tx) => {
    await tx.insert(checkIns).values({ outlineItemId });
    await tx.update(outlineItems).set({ status: "completed" }).where(eq(outlineItems.id, outlineItemId));
  });
}
```

- [ ] **Step 2: Add the `track` relation used by `with: { track: true }`**

Modify `lib/db/schema.ts` — append after the table definitions:

```typescript
import { relations } from "drizzle-orm";

export const outlineItemsRelations = relations(outlineItems, ({ one }) => ({
  track: one(tracks, { fields: [outlineItems.trackId], references: [tracks.id] }),
}));
```

- [ ] **Step 3: Verify the project still builds**

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add lib/db/queries.ts lib/db/schema.ts
git commit -m "feat: add database query helpers for tracks, outline items, and check-ins"
```

---

### Task 10: Track creation flow (`/tracks/new`)

**Files:**
- Create: `app/tracks/new/actions.ts`
- Create: `app/tracks/new/page.tsx`
- Create: `app/tracks/new/OutlineDraftEditor.tsx`

**Interfaces:**
- Consumes: `generateOutlineDraft` (Task 7), `createTrackWithOutline` (Task 9), `AVAILABLE_MODELS`/`DEFAULT_OUTLINE_MODEL` (Task 4), `outlineDraftSchema`/`OutlineDraft` (Task 6).
- Produces: `generateOutlineDraftAction(formData): Promise<OutlineDraft>`, `confirmTrackAction(input): Promise<{ trackId: string }>` — both exported `'use server'` actions, consumed only by this page in this task.

- [ ] **Step 1: Write the server actions**

Create `app/tracks/new/actions.ts`:

```typescript
"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { generateOutlineDraft } from "@/lib/ai/outline";
import { createTrackWithOutline } from "@/lib/db/queries";
import type { OutlineDraft } from "@/lib/schemas/outline";
import type { AiModelId } from "@/lib/ai/models";

export async function generateOutlineDraftAction(input: {
  topic: string;
  periodDays?: number;
  sources: { url: string; title?: string }[];
  existingDraft?: OutlineDraft;
  feedback?: string;
  model: AiModelId;
}): Promise<OutlineDraft> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  return generateOutlineDraft(input);
}

export async function confirmTrackAction(input: {
  topic: string;
  sources: { url: string; title?: string; type: "link" | "youtube" }[];
  draft: OutlineDraft;
}): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const { trackId } = await createTrackWithOutline({
    userId,
    title: input.topic,
    sources: input.sources,
    items: input.draft.items,
  });

  redirect(`/tracks/${trackId}`);
}
```

- [ ] **Step 2: Write the draft editor client component**

Create `app/tracks/new/OutlineDraftEditor.tsx`:

```typescript
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AVAILABLE_MODELS, DEFAULT_OUTLINE_MODEL, type AiModelId } from "@/lib/ai/models";
import type { OutlineDraft } from "@/lib/schemas/outline";
import { generateOutlineDraftAction, confirmTrackAction } from "./actions";

interface Props {
  topic: string;
  periodDays?: number;
  sources: { url: string; title?: string; type: "link" | "youtube" }[];
  initialDraft: OutlineDraft;
}

export function OutlineDraftEditor({ topic, periodDays, sources, initialDraft }: Props) {
  const [draft, setDraft] = useState(initialDraft);
  const [feedback, setFeedback] = useState("");
  const [model, setModel] = useState<AiModelId>(DEFAULT_OUTLINE_MODEL);
  const [isPending, setIsPending] = useState(false);

  async function handleRegenerate() {
    setIsPending(true);
    try {
      const newDraft = await generateOutlineDraftAction({
        topic,
        periodDays,
        sources,
        existingDraft: draft,
        feedback,
        model,
      });
      setDraft(newDraft);
      setFeedback("");
    } finally {
      setIsPending(false);
    }
  }

  async function handleConfirm() {
    setIsPending(true);
    try {
      await confirmTrackAction({ topic, sources, draft });
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {draft.items.map((item) => (
          <li key={item.dayIndex} className="rounded border p-3">
            <div className="font-medium">Day {item.dayIndex}: {item.title}</div>
            <div className="text-sm text-muted-foreground">{item.summary}</div>
          </li>
        ))}
      </ul>

      <Textarea
        placeholder="有什么想调整的？比如'第5-10天太难了，拆细一点'"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />

      <div className="flex items-center gap-2">
        <Select value={model} onValueChange={(v) => setModel(v as AiModelId)}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AVAILABLE_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button variant="secondary" onClick={handleRegenerate} disabled={isPending}>
          重新生成
        </Button>
        <Button onClick={handleConfirm} disabled={isPending}>
          确认
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the page**

Create `app/tracks/new/page.tsx`:

```typescript
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AVAILABLE_MODELS, DEFAULT_OUTLINE_MODEL, type AiModelId } from "@/lib/ai/models";
import type { OutlineDraft } from "@/lib/schemas/outline";
import { generateOutlineDraftAction } from "./actions";
import { OutlineDraftEditor } from "./OutlineDraftEditor";

export default function NewTrackPage() {
  const [topic, setTopic] = useState("");
  const [periodDays, setPeriodDays] = useState<number | undefined>(undefined);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sources, setSources] = useState<{ url: string; title?: string; type: "link" | "youtube" }[]>([]);
  const [model, setModel] = useState<AiModelId>(DEFAULT_OUTLINE_MODEL);
  const [draft, setDraft] = useState<OutlineDraft | null>(null);
  const [isPending, setIsPending] = useState(false);

  function addSource() {
    if (!sourceUrl.trim()) return;
    const type = sourceUrl.includes("youtube.com") || sourceUrl.includes("youtu.be") ? "youtube" : "link";
    setSources((prev) => [...prev, { url: sourceUrl.trim(), type }]);
    setSourceUrl("");
  }

  async function handleGenerate() {
    setIsPending(true);
    try {
      const result = await generateOutlineDraftAction({ topic, periodDays, sources, model });
      setDraft(result);
    } finally {
      setIsPending(false);
    }
  }

  if (draft) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <h1 className="text-xl font-semibold">确认大纲：{topic}</h1>
        <OutlineDraftEditor topic={topic} periodDays={periodDays} sources={sources} initialDraft={draft} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">新建学习方向</h1>
      <Input placeholder="想学什么？比如 System Design 面试准备" value={topic} onChange={(e) => setTopic(e.target.value)} />
      <Input
        type="number"
        placeholder="计划学习天数（可选）"
        value={periodDays ?? ""}
        onChange={(e) => setPeriodDays(e.target.value ? Number(e.target.value) : undefined)}
      />
      <div className="flex gap-2">
        <Input placeholder="参考链接（可选，含 YouTube）" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
        <Button variant="secondary" onClick={addSource}>添加</Button>
      </div>
      <ul className="text-sm text-muted-foreground">
        {sources.map((s) => (
          <li key={s.url}>{s.url}</li>
        ))}
      </ul>
      <Select value={model} onValueChange={(v) => setModel(v as AiModelId)}>
        <SelectTrigger className="w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AVAILABLE_MODELS.map((m) => (
            <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button onClick={handleGenerate} disabled={isPending || !topic.trim()}>
        生成大纲
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Verify manually**

Run `npm run dev`, sign in, visit `/tracks/new`. Enter a topic (e.g. "System Design 面试准备"), click "生成大纲". Confirm a draft list appears. Type feedback, click "重新生成", confirm the list updates. Click "确认", confirm you're redirected to `/tracks/[id]` (a 404 is fine for now — that page doesn't exist until Task 11). Then check `npx drizzle-kit studio` and confirm rows exist in `tracks` and `outline_items`.

- [ ] **Step 5: Commit**

```bash
git add app/tracks/new
git commit -m "feat: add track creation flow with outline draft confirm UI"
```

---

### Task 11: Dashboard and track detail pages

**Files:**
- Create: `app/dashboard/page.tsx`
- Create: `app/tracks/[id]/page.tsx`
- Modify: `app/page.tsx` (redirect to `/dashboard`)

**Interfaces:**
- Consumes: `getTracksForUser`, `getTrackDetail`, `getCheckInDatesForUser` (Task 9), `computeStreak` (Task 5).

- [ ] **Step 1: Redirect the root page to the dashboard**

Modify `app/page.tsx`:

```typescript
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/dashboard");
}
```

- [ ] **Step 2: Write the dashboard page**

Create `app/dashboard/page.tsx`:

```typescript
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { getTracksForUser, getCheckInDatesForUser } from "@/lib/db/queries";
import { computeStreak } from "@/lib/streak";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) return null;

  const [tracks, checkInDates] = await Promise.all([
    getTracksForUser(userId),
    getCheckInDatesForUser(userId),
  ]);
  const streak = computeStreak(checkInDates);

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">我的学习 · 连续打卡 {streak} 天</h1>
        <Button asChild>
          <Link href="/tracks/new">+ 新建 Track</Link>
        </Button>
      </div>
      <div className="grid gap-3">
        {tracks.map((track) => (
          <Link key={track.id} href={`/tracks/${track.id}`}>
            <Card>
              <CardHeader>
                <CardTitle>{track.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                状态：{track.status}
              </CardContent>
            </Card>
          </Link>
        ))}
        {tracks.length === 0 && (
          <p className="text-sm text-muted-foreground">还没有学习方向，点右上角新建一个吧。</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the track detail page**

Create `app/tracks/[id]/page.tsx`:

```typescript
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { getTrackDetail } from "@/lib/db/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default async function TrackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { userId } = await auth();
  if (!userId) return null;

  const { id } = await params;
  const detail = await getTrackDetail(id, userId);
  if (!detail) notFound();

  const { track, items } = detail;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{track.title}</h1>
        <Button asChild variant="secondary">
          <Link href={`/tracks/${track.id}/adjust`}>调整计划</Link>
        </Button>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={`/tracks/${track.id}/day/${item.dayIndex}`}
              className="flex items-center justify-between rounded border p-3 hover:bg-muted"
            >
              <span>Day {item.dayIndex}: {item.title}</span>
              <Badge variant={item.status === "completed" ? "default" : "secondary"}>
                {item.status}
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Verify manually**

Run `npm run dev`. Visit `/dashboard`, confirm the Track created in Task 10 appears with status "active". Click into it, confirm `/tracks/[id]` lists every outline day with a "pending" badge.

- [ ] **Step 5: Commit**

```bash
git add app/dashboard app/tracks/[id]/page.tsx app/page.tsx
git commit -m "feat: add dashboard and track detail pages"
```

---

### Task 12: Adjust-plan flow (`/tracks/[id]/adjust`)

**Files:**
- Create: `app/tracks/[id]/actions.ts`
- Create: `app/tracks/[id]/adjust/page.tsx`
- Create: `app/tracks/[id]/adjust/AdjustDraftEditor.tsx`

**Interfaces:**
- Consumes: `generateOutlineDraft` (Task 7), `computeOutlineReplacement` (Task 6), `replaceUnfinishedOutlineItems`/`getTrackDetail` (Task 9).
- Produces: `reviseOutlineDraftAction`, `confirmRevisionAction` — `'use server'` actions in `app/tracks/[id]/actions.ts` (this file also gains `markCompleteAction` in Task 13).

- [ ] **Step 1: Write the revise/confirm server actions**

Create `app/tracks/[id]/actions.ts`:

```typescript
"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { generateOutlineDraft } from "@/lib/ai/outline";
import { computeOutlineReplacement } from "@/lib/outlineRevision";
import { getTrackDetail, replaceUnfinishedOutlineItems } from "@/lib/db/queries";
import type { OutlineDraft } from "@/lib/schemas/outline";
import type { AiModelId } from "@/lib/ai/models";

export async function reviseOutlineDraftAction(input: {
  trackId: string;
  feedback: string;
  existingDraft?: OutlineDraft;
  model: AiModelId;
}): Promise<OutlineDraft> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const detail = await getTrackDetail(input.trackId, userId);
  if (!detail) throw new Error("Track not found");

  const unfinished = detail.items.filter((i) => i.status !== "completed");
  const baseDraft: OutlineDraft =
    input.existingDraft ?? {
      items: unfinished.map((i) => ({ dayIndex: i.dayIndex, title: i.title, summary: i.summary })),
    };

  return generateOutlineDraft({
    topic: detail.track.title,
    sources: detail.sources,
    existingDraft: baseDraft,
    feedback: input.feedback,
    model: input.model,
  });
}

export async function confirmRevisionAction(input: {
  trackId: string;
  draft: OutlineDraft;
}): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const detail = await getTrackDetail(input.trackId, userId);
  if (!detail) throw new Error("Track not found");

  const reindexed = computeOutlineReplacement(
    detail.items.map((i) => ({ dayIndex: i.dayIndex, status: i.status })),
    input.draft.items.map((i) => ({ title: i.title, summary: i.summary })),
  );

  await replaceUnfinishedOutlineItems(input.trackId, userId, reindexed);
  redirect(`/tracks/${input.trackId}`);
}
```

- [ ] **Step 2: Write the adjust-draft editor**

Create `app/tracks/[id]/adjust/AdjustDraftEditor.tsx` — same shape as `OutlineDraftEditor` from Task 10, but calling `reviseOutlineDraftAction`/`confirmRevisionAction` instead:

```typescript
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AVAILABLE_MODELS, DEFAULT_OUTLINE_MODEL, type AiModelId } from "@/lib/ai/models";
import type { OutlineDraft } from "@/lib/schemas/outline";
import { reviseOutlineDraftAction, confirmRevisionAction } from "../actions";

export function AdjustDraftEditor({ trackId }: { trackId: string }) {
  const [draft, setDraft] = useState<OutlineDraft | null>(null);
  const [feedback, setFeedback] = useState("");
  const [model, setModel] = useState<AiModelId>(DEFAULT_OUTLINE_MODEL);
  const [isPending, setIsPending] = useState(false);

  async function handleGenerate() {
    setIsPending(true);
    try {
      const result = await reviseOutlineDraftAction({ trackId, feedback, existingDraft: draft ?? undefined, model });
      setDraft(result);
      setFeedback("");
    } finally {
      setIsPending(false);
    }
  }

  async function handleConfirm() {
    if (!draft) return;
    setIsPending(true);
    try {
      await confirmRevisionAction({ trackId, draft });
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="space-y-4">
      {draft && (
        <ul className="space-y-2">
          {draft.items.map((item) => (
            <li key={item.dayIndex} className="rounded border p-3">
              <div className="font-medium">Day {item.dayIndex}: {item.title}</div>
              <div className="text-sm text-muted-foreground">{item.summary}</div>
            </li>
          ))}
        </ul>
      )}

      <Textarea
        placeholder="想怎么调整？比如'加两天专门讲缓存'"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />

      <div className="flex items-center gap-2">
        <Select value={model} onValueChange={(v) => setModel(v as AiModelId)}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AVAILABLE_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="secondary" onClick={handleGenerate} disabled={isPending || !feedback.trim()}>
          {draft ? "重新生成" : "生成草稿"}
        </Button>
        {draft && (
          <Button onClick={handleConfirm} disabled={isPending}>确认</Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the adjust page**

Create `app/tracks/[id]/adjust/page.tsx`:

```typescript
import { AdjustDraftEditor } from "./AdjustDraftEditor";

export default async function AdjustTrackPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">调整学习计划</h1>
      <p className="text-sm text-muted-foreground">
        只会替换还没学完的部分，已经打卡完成的天数不会被改动。
      </p>
      <AdjustDraftEditor trackId={id} />
    </div>
  );
}
```

- [ ] **Step 4: Verify manually**

Run `npm run dev`. From `/tracks/[id]`, click "调整计划". Type feedback (e.g. "加一天讲消息队列"), generate a draft, confirm it. Verify you're redirected back to `/tracks/[id]` and the new days appear appended after the existing pending items, with correct sequential `dayIndex` values (check via `npx drizzle-kit studio`).

- [ ] **Step 5: Commit**

```bash
git add app/tracks/[id]/actions.ts app/tracks/[id]/adjust
git commit -m "feat: add mid-course outline adjustment flow"
```

---

### Task 13: Daily content page and check-in

**Files:**
- Create: `app/tracks/[id]/day/[dayIndex]/actions.ts`
- Create: `app/tracks/[id]/day/[dayIndex]/page.tsx`
- Create: `app/tracks/[id]/day/[dayIndex]/DailyContentView.tsx`
- Modify: `app/tracks/[id]/actions.ts` (add `markCompleteAction`)
- Install: `react-markdown` (for rendering `contentMarkdown`)

**Interfaces:**
- Consumes: `generateDailyContent` (Task 8), `getOutlineItemWithContent`/`upsertDailyContent`/`markOutlineItemComplete` (Task 9), `AVAILABLE_MODELS`/`DEFAULT_CONTENT_MODEL` (Task 4).

- [ ] **Step 1: Install the markdown renderer**

```bash
npm install react-markdown
```

- [ ] **Step 2: Add `markCompleteAction` to the track actions file**

Modify `app/tracks/[id]/actions.ts` — append:

```typescript
import { markOutlineItemComplete } from "@/lib/db/queries";

export async function markCompleteAction(outlineItemId: string): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  await markOutlineItemComplete(outlineItemId, userId);
}
```

- [ ] **Step 3: Write the day-page server actions**

Create `app/tracks/[id]/day/[dayIndex]/actions.ts`:

```typescript
"use server";

import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { outlineItems, tracks, sources } from "@/lib/db/schema";
import { generateDailyContent } from "@/lib/ai/dailyContent";
import { upsertDailyContent } from "@/lib/db/queries";
import type { AiModelId } from "@/lib/ai/models";

export async function generateDailyContentAction(input: {
  trackId: string;
  dayIndex: number;
  model: AiModelId;
}): Promise<{ contentMarkdown: string; citations: { title: string; url: string }[] }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const track = await db.query.tracks.findFirst({
    where: and(eq(tracks.id, input.trackId), eq(tracks.userId, userId)),
  });
  if (!track) throw new Error("Track not found");

  const item = await db.query.outlineItems.findFirst({
    where: and(eq(outlineItems.trackId, input.trackId), eq(outlineItems.dayIndex, input.dayIndex)),
  });
  if (!item) throw new Error("Outline item not found");

  const trackSources = await db.query.sources.findMany({ where: eq(sources.trackId, input.trackId) });

  const result = await generateDailyContent({
    title: item.title,
    summary: item.summary,
    sources: trackSources.map((s) => ({ url: s.url, title: s.title ?? undefined, type: s.type as "link" | "youtube" })),
    model: input.model,
  });

  await upsertDailyContent(item.id, {
    contentMarkdown: result.contentMarkdown,
    citations: result.citations,
    model: input.model,
  });

  return result;
}
```

- [ ] **Step 4: Write the client view component**

Create `app/tracks/[id]/day/[dayIndex]/DailyContentView.tsx`:

```typescript
"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AVAILABLE_MODELS, DEFAULT_CONTENT_MODEL, type AiModelId } from "@/lib/ai/models";
import { generateDailyContentAction } from "./actions";
import { markCompleteAction } from "../../actions";

interface Source {
  url: string;
  title: string | null;
  type: "link" | "youtube";
}

interface Props {
  trackId: string;
  dayIndex: number;
  outlineItemId: string;
  initialContent: { contentMarkdown: string; citations: { title: string; url: string }[]; model: string } | null;
  youtubeSources: Source[];
  isCompleted: boolean;
}

export function DailyContentView({
  trackId,
  dayIndex,
  outlineItemId,
  initialContent,
  youtubeSources,
  isCompleted,
}: Props) {
  const [content, setContent] = useState(initialContent);
  const [model, setModel] = useState<AiModelId>(
    (initialContent?.model as AiModelId) ?? DEFAULT_CONTENT_MODEL,
  );
  const [isPending, setIsPending] = useState(false);
  const [completed, setCompleted] = useState(isCompleted);

  async function handleGenerate() {
    setIsPending(true);
    try {
      const result = await generateDailyContentAction({ trackId, dayIndex, model });
      setContent({ ...result, model });
    } finally {
      setIsPending(false);
    }
  }

  async function handleMarkComplete() {
    setIsPending(true);
    try {
      await markCompleteAction(outlineItemId);
      setCompleted(true);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={model} onValueChange={(v) => setModel(v as AiModelId)}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AVAILABLE_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="secondary" onClick={handleGenerate} disabled={isPending}>
          {content ? "换个模型重新生成" : "生成教材"}
        </Button>
      </div>

      {content && (
        <>
          <article className="prose max-w-none">
            <ReactMarkdown>{content.contentMarkdown}</ReactMarkdown>
          </article>

          {content.citations.length > 0 && (
            <div className="text-sm text-muted-foreground">
              <div className="font-medium">引用来源：</div>
              <ul className="list-disc pl-5">
                {content.citations.map((c) => (
                  <li key={c.url}>
                    <a href={c.url} target="_blank" rel="noreferrer" className="underline">
                      {c.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {youtubeSources.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-medium">相关视频：</div>
              {youtubeSources.map((s) => (
                <a
                  key={s.url}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded border p-3 hover:bg-muted"
                >
                  {s.title ?? s.url}
                </a>
              ))}
            </div>
          )}

          <Button onClick={handleMarkComplete} disabled={isPending || completed}>
            {completed ? "已完成" : "标记完成"}
          </Button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Write the day page**

Create `app/tracks/[id]/day/[dayIndex]/page.tsx`:

```typescript
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { outlineItems, tracks, sources, dailyContent } from "@/lib/db/schema";
import { DailyContentView } from "./DailyContentView";

export default async function DayPage({
  params,
}: {
  params: Promise<{ id: string; dayIndex: string }>;
}) {
  const { userId } = await auth();
  if (!userId) return null;

  const { id, dayIndex } = await params;

  const track = await db.query.tracks.findFirst({
    where: and(eq(tracks.id, id), eq(tracks.userId, userId)),
  });
  if (!track) notFound();

  const item = await db.query.outlineItems.findFirst({
    where: and(eq(outlineItems.trackId, id), eq(outlineItems.dayIndex, Number(dayIndex))),
  });
  if (!item) notFound();

  const content = await db.query.dailyContent.findFirst({
    where: eq(dailyContent.outlineItemId, item.id),
  });
  const trackSources = await db.query.sources.findMany({ where: eq(sources.trackId, id) });
  const youtubeSources = trackSources.filter((s) => s.type === "youtube");

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">Day {item.dayIndex}: {item.title}</h1>
      <p className="text-sm text-muted-foreground">{item.summary}</p>
      <DailyContentView
        trackId={id}
        dayIndex={item.dayIndex}
        outlineItemId={item.id}
        initialContent={
          content
            ? { contentMarkdown: content.contentMarkdown, citations: content.citations as { title: string; url: string }[], model: content.model }
            : null
        }
        youtubeSources={youtubeSources}
        isCompleted={item.status === "completed"}
      />
    </div>
  );
}
```

- [ ] **Step 6: Verify manually — full end-to-end flow**

Run `npm run dev`. From `/tracks/[id]`, click into "Day 1". Confirm no content exists yet, generate it, confirm markdown renders with citations. Click "标记完成", confirm the button switches to "已完成" and disabled. Go back to `/tracks/[id]`, confirm Day 1's badge now shows "completed". Return to the day page, click "换个模型重新生成" with a different model selected, confirm the content updates and `daily_content.model` reflects the new choice (check via `npx drizzle-kit studio`). Go to `/dashboard`, confirm the streak now shows 1.

- [ ] **Step 7: Commit**

```bash
git add app/tracks/[id]/day app/tracks/[id]/actions.ts package.json package-lock.json
git commit -m "feat: add daily content generation, regeneration, and check-in"
```

---

## Self-Review Notes

- **Spec coverage:** every MVP bullet from the design doc has a task — outline draft + conversational confirm (Tasks 7, 10), mid-course adjustment restricted to non-completed items (Tasks 6, 12), on-demand daily content with citations (Tasks 8, 13), YouTube link-card-only embedding (Task 13's `youtubeSources` rendering + the prompt instruction in Task 8), per-generation model selection (Task 4, wired into Tasks 10, 12, 13), simple check-in + streak (Tasks 5, 13), multi-tenant schema (Task 2, enforced via `userId` scoping in every query in Task 9).
- **No placeholders:** every step has real code, no "TODO"/"similar to Task N" shortcuts.
- **Type consistency checked:** `OutlineDraft`/`OutlineDraftItem` (Task 6) flow unchanged through Tasks 7, 10, 12; `AiModelId` (Task 4) flows unchanged through Tasks 7, 8, 10, 12, 13; `computeOutlineReplacement`'s `ExistingItem.status` union matches `outlineItems.status` enum values from the schema (Task 2).
