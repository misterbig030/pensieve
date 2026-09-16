# Outline review workspace — plan + conversation rail

Source of truth: Claude Design project `3e941712-c90a-4ea5-b04a-440b235b745c`, file `Pensieve.dc.html`
(2026-09-15). Only the **Outline review / Adjust plan** screen changes; the track detail page gains a
Summary card. Dashboard, new-track form, and day view are untouched.

## 0. What the design specifies

**Layout.** Wide shell (1280px). Two columns: plan (`2fr`) and a sticky conversation rail (`minmax(320px,1fr)`).
Rail collapses to a 56px vertical tab with an unread dot. Below 900px the rail is a fixed bottom sheet
(64px bar closed, 78vh open).

**Plan column.** Summary card (skeleton lines while streaming; accent tint + inset ring while a change is
highlighted). Phase blocks with day chips that now show a one-line summary. While drafting, unfilled slots
render as shimmer skeleton chips and the phase focus reads "Drafting…". Changed chips get an accent tint and a
"Changed" pill. Footer: **Confirm plan** (disabled while streaming), "Drafting day N of M…" indicator, cost note.

**Rail.** Message kinds: `sys` (lock icon; adjust mode only), `brief` (the collapsed form: topic, length, focus,
material tags), `user`, `answer` (streamed text with caret), `change` (kicker "Plan changed" / "Change undone",
day tags, note, Undo on the latest non-undone change only). Suggestion chips until the first user message.
Composer: Enter sends, Shift+Enter newline, hint "Ask a question or describe a change — answers leave the plan
alone." Placeholder differs by mode and while busy.

**Behavior.**
- Generate → outline screen with the brief as message 1, days stream in, then the summary appears and the
  assistant posts "Drafted N days in K phases. Ask me why…".
- Send → **the model decides**: answer (text only, plan untouched) or change (plan replaced, change note,
  changed days highlighted, summary gets "Latest change: …"). Cost accumulates on the draft.
- Undo restores the previous items + summary, marks the change undone, re-highlights those days.
- Adjust mode opens directly with the remaining days (no pre-generation step) and a `sys` line naming the locked days.
- Confirm (create) stores the summary on the track; confirm (adjust) replaces unfinished days and refreshes the summary.

## 1. Architecture decisions

- **Two operations, one chat.** `streamText` with a single tool `reviseOutline({ changeRequest })`. The tool runs the
  existing `generateOutlineDraft` with `existingDraft` + `feedback`, so the W4 golden set still tests the
  generator directly. Text turns never touch the plan.
- **Streaming over NDJSON route handlers**, not server actions. Two routes: `POST /api/outline/draft` (streamObject →
  partial items) and `POST /api/outline/chat` (streamText → text / revising / revised / finish). A 40-line client
  reader replaces `@ai-sdk/react`; no new dependency.
- **Summary is deterministic** (`lib/outlineSummary.ts`), matching the prototype's `summarize()`. Zero cost, testable.
  The "Latest change" clause comes from the model's change note.
- **Logging.** Draft stream logs caller `outline`; chat turns log caller `chat`; the tool's revision logs
  `outline_revision` through the existing wrapper. `caller` gains `"chat"` (TS enum only — the column has no CHECK).
- **Schema.** `tracks.summary text` (nullable). Migration 0004.
- **Changed-day detection** is a content diff (title+summary pairs absent from the previous draft), with a seam
  fallback when only the length changed.

## 2. Tasks

1. Pure libs + tests: `lib/outlineSummary.ts`, `lib/outlineChat.ts` (message types, transcript → model messages,
   undo), `lib/ndjson.ts`.
2. Schema + migration + queries (`summary` on create, `updateTrackSummary`).
3. AI: `lib/ai/logged.ts` exposes `buildGenerationLogRow`; `lib/ai/outlineChat.ts` builds the system prompt and runs
   the tool loop as an async generator of events (unit-tested prompt builder).
4. Routes: `app/api/outline/draft/route.ts`, `app/api/outline/chat/route.ts` (Clerk `auth()` guard).
5. UI: `components/pensieve/OutlineWorkspace.tsx`, `ConversationRail.tsx`, `PlanSummaryCard.tsx`, `DayChip` gains
   `summary` / `changed` / skeleton; `PageShell` gains `wide`. Rewire `NewTrackForm` and `AdjustPlan`; confirm actions
   carry `summary`; track detail shows the Summary card.
6. `tsc`, `eslint`, `vitest`; manual pass in the browser against the running dev server.

## 3. Out of scope this round

Persisting the conversation after confirm; a `loggedStreamText` wrapper (routes log inline via
`buildGenerationLogRow`); model choice per turn; evals for the chat layer (W5 judge).
