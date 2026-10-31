# Free Monthly Credits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every user 500 free credits ($5 of model cost) a month. A new plan draft or a chat turn is refused when they run out, and the balance shows on Settings and in the top bar.

**Architecture:** The balance is derived on demand from `generation_log`: the allowance minus this UTC month's `key_owner = 'app'` cost for the user. There's no new table. Pure rules live in `lib/credits.ts`, the one query in `lib/db/credits.ts`, and the gate that the two routes call in `lib/ai/creditGate.ts`. The 402 refusal travels through `readNdjson` as an error with a code, and `PlanWorkspace` shows `OutOfCreditsAlert` for it.

**Tech Stack:** Next.js 16 App Router, Drizzle (Neon in the app, pglite in tests), Vitest, Clerk.

**Spec:** `docs/superpowers/specs/2026-10-30-free-monthly-credits-design.md`

## Global Constraints

- Allowance: `MONTHLY_FREE_CREDIT_USD = 5`, one constant in `lib/credits.ts`. 1 credit = $0.01 (`CREDITS_PER_USD = 100`), so 500 credits.
- The month is the calendar month in UTC; resets are at 00:00 UTC on the 1st. A negative balance is wiped at reset (this falls out of summing a new window).
- Credits are shown as whole numbers, rounded down, never below 0.
- Only `app/api/plan/draft/route.ts` and `app/api/plan/chat/route.ts` are checked. Both expand entry points and daily content are never checked.
- The check is skipped when every role the route uses has `keyOwner === "user"`, and for `isAdminUserId(userId)`.
- The refusal code is `"out_of_credits"`. It is not added to `KEY_ERRORS`, whose `"credits"` means the user's own provider account ran dry.
- The refusal is `402` with JSON `{ code: "out_of_credits", resetsAt: <ISO string> }`, returned before any model call and before the NDJSON stream opens.
- Alert buttons open Settings with `target="_blank"`, so `installLeaveGuard` ignores them and an unsaved draft survives.
- `.env.local`'s `DATABASE_URL` is the production database. Applying the migration needs the user's go-ahead first; the migration is additive (one index).
- UI copy is English, matching the existing Settings page.
- **Build from `origin/main` at or after `3faa104` (PR 32, the app shell redesign), not from this checkout's `main`, which is 50 commits behind.** That PR replaced `TopNav` with `TopBar` and added `AccountCard` to Settings. The draft and chat routes, `PlanWorkspace`, `lib/ndjson.ts`, `lib/ai/resolve.ts` and `lib/db/schema.ts` are unchanged by it. The spec, the mockups and this plan exist only as uncommitted files in this checkout, so copy them into the worktree.
- New cards match the Settings cards (`ApiKeyCard`, `AccountCard`): a `div` with `rounded-xl bg-card p-5 text-sm text-card-foreground ring-1 ring-foreground/10` and an `h3` with `font-heading text-[18px]`. They don't use `components/ui/card`.

**Decision in this plan:** the gate refuses when the **displayed** whole credits are below 1, rather than when the USD remaining is ≤ 0. A user who sees "0 credits" is therefore always refused. The spec fixes what the user sees, and this keeps the check consistent with it. The difference is under one cent.

## Review Focus

1. **The month boundary in UTC.** A call logged at 23:59:59 UTC on Oct 31 counts toward October, and one at 00:00:00 UTC Nov 1 counts toward November. The December → January rollover resets in January. *(Task 1 and Task 2 tests.)*
2. **Rows that aren't the user's app spend.** Rows with `key_owner = 'user'`, another user's rows, and eval rows with `user_id` null must not reduce the balance. *(Task 2 test.)*
3. **Fractional and negative spend.** $4.996 spent shows 0 credits and is refused. $4.99 shows 1 and is allowed. $7 spent (overdraft) shows 0, not a negative number. *(Task 1 test.)*
4. **Other non-OK responses keep working.** A 401 "Not authenticated" or 400 plain-text body must still throw its text as before, and a 402 with a body that isn't JSON must not crash the reader. *(Task 4 test.)*
5. **A user whose key covers every role.** They are never refused at any balance, and the top bar shows no credit figure for them. *(Task 3 and Task 1 tests.)*

---

### Task 1: Credit rules (pure)

**Files:**
- Create: `lib/credits.ts`. It is imported by client code (`lib/ndjson.ts`, `OutOfCreditsAlert`), so it must import nothing that reaches the DB or `lib/secrets`. Type-only imports are fine.
- Test: `lib/credits.test.ts`
- Modify: `lib/ai/resolve.ts`, to add `keyCoversAll` next to `resolveWith`, whose rule it mirrors
- Test: `lib/ai/resolve.test.ts`

**Interfaces:**
- Produces:
  - `MONTHLY_FREE_CREDIT_USD = 5`, `CREDITS_PER_USD = 100`, `OUT_OF_CREDITS = "out_of_credits"` (as const)
  - `monthStart(now: Date): Date`: 00:00 UTC on the 1st of `now`'s UTC month
  - `nextReset(now: Date): Date`: 00:00 UTC on the 1st of the next UTC month
  - `creditsLeft(spentUsd: number, allowanceUsd = MONTHLY_FREE_CREDIT_USD): number`: `max(0, floor((allowanceUsd − spentUsd) × CREDITS_PER_USD))`, computed so float error doesn't drop a credit (for example, round the product to 6 decimal places before the floor)
  - In `lib/ai/resolve.ts`: `keyCoversAll(storedProviders: readonly ModelProvider[], roles: readonly AiModelId[] = Object.values(DEFAULT_MODEL_IDS)): boolean`. It is true when every role's provider is in `storedProviders`, has an entry in `DIRECT_PROVIDERS`, and has an api id for that model. This mirrors `resolveWith`'s rule without decrypting anything.
  - `formatReset(date: Date): string`: `toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })`, for example `"1 Dec"`

- [ ] **Step 1: Write the failing tests**

```ts
describe("month window", () => {
  it("starts at 00:00 UTC on the 1st", () => {
    expect(monthStart(new Date("2026-10-31T23:59:59Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(monthStart(new Date("2026-11-01T00:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
  it("resets on the next 1st, across a year end", () => {
    expect(nextReset(new Date("2026-10-15T08:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(nextReset(new Date("2026-12-31T23:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(formatReset(new Date("2026-12-01T00:00:00Z"))).toBe("1 Dec");
  });
});
describe("creditsLeft", () => {
  it("rounds down and never goes below zero", () => {
    expect(creditsLeft(0)).toBe(500);
    expect(creditsLeft(0.004)).toBe(499);
    expect(creditsLeft(4.99)).toBe(1);
    expect(creditsLeft(4.996)).toBe(0);
    expect(creditsLeft(7)).toBe(0);
    expect(creditsLeft(0.1 + 0.2)).toBe(470);
  });
});
// in lib/ai/resolve.test.ts
describe("keyCoversAll", () => {
  it("is true only when every role's provider has a usable stored key", () => {
    expect(keyCoversAll(["anthropic"])).toBe(true); // every default today is Anthropic
    expect(keyCoversAll([])).toBe(false);
    expect(keyCoversAll(["anthropic"], ["anthropic/claude-sonnet-5.5", "google/gemini-3-flash"])).toBe(false);
  });
});
```

- [ ] **Step 2: Run `npx vitest run lib/credits.test.ts lib/ai/resolve.test.ts`.** Expected: FAIL, because the module and `keyCoversAll` aren't found.
- [ ] **Step 3: Implement `lib/credits.ts` with the signatures above, and add `keyCoversAll` to `lib/ai/resolve.ts`** (using `providerOf` from `lib/ai/models.ts`).
- [ ] **Step 4: Run `npx vitest run lib/credits.test.ts lib/ai/resolve.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** these files, plus the spec `docs/superpowers/specs/2026-10-30-free-monthly-credits-design.md`, the mockups `docs/mockups/free-credits.html` and this plan, with the message `feat(credits): monthly credit rules`.

### Task 2: This month's app spend, with an index

**Files:**
- Modify: `lib/db/schema.ts`. `generationLog` gets a third `pgTable` argument: `(t) => [index("generation_log_user_created_idx").on(t.userId, t.createdAt)]`. Import `index` from `drizzle-orm/pg-core`.
- Create: `drizzle/0016_generation_log_user_created.sql` (generated) and its `drizzle/meta` snapshot and journal entry
- Create: `lib/db/credits.ts`
- Test: `lib/db/credits.test.ts`

**Interfaces:**
- Produces: `getAppSpendUsd(userId: string, since: Date): Promise<number>`. Returns `coalesce(sum(cost_usd), 0)` over rows with this `user_id`, `key_owner = 'app'` and `created_at >= since`, as a JS number.

- [ ] **Step 1: Write the failing test** in the `userApiKeys.test.ts` style: `vi.mock("./client", …createTestDb…)`, then insert rows with `db.insert(generationLog)`.

```ts
it("sums only this user's app-paid rows since the month start", async () => {
  // u1 app: 1.25 on Oct 31 23:59:59Z (before), 0.5 on Nov 1 00:00Z, 0.25 on Nov 20
  // u1 user-key: 3.00 on Nov 5;  u2 app: 2.00 on Nov 5;  null user app: 9.00 on Nov 5
  expect(await getAppSpendUsd("u1", new Date("2026-11-01T00:00:00Z"))).toBeCloseTo(0.75);
  expect(await getAppSpendUsd("nobody", new Date("2026-11-01T00:00:00Z"))).toBe(0);
});
```

Rows need the not-null columns `caller`, `model`, `costUsd`, `latencyMs`, with `keyOwner` and `createdAt` set explicitly.

- [ ] **Step 2: Run `npx vitest run lib/db/credits.test.ts`.** Expected: FAIL, because the module isn't found.
- [ ] **Step 3: Add the index to the schema, then run `npx drizzle-kit generate --name generation_log_user_created`.** Expected: a new `drizzle/0016_…sql` with one `CREATE INDEX` and no prompt, because the change only adds. Don't run `drizzle-kit migrate` here; see Task 6.
- [ ] **Step 4: Implement `getAppSpendUsd` in `lib/db/credits.ts`** with drizzle's `sum()` and `and(eq, eq, gte)`. `sum` returns a string or null, so convert it with `Number(... ?? 0)`.
- [ ] **Step 5: Run `npx vitest run lib/db/credits.test.ts`.** Expected: PASS. The pglite test DB applies the new migration too.
- [ ] **Step 6: Commit** with the message `feat(credits): a user's app spend this month, indexed`.

### Task 3: The gate, wired into draft and chat

**Files:**
- Create: `lib/ai/creditGate.ts`
- Test: `lib/ai/creditGate.test.ts`
- Modify: `app/api/plan/draft/route.ts`, right after `const models = await resolveModels(userId);`
- Modify: `app/api/plan/chat/route.ts`, right after `const models = await resolveModels(userId);`

**Interfaces:**
- Consumes: `monthStart`, `nextReset`, `creditsLeft`, `OUT_OF_CREDITS` (Task 1); `getAppSpendUsd` (Task 2); `ResolvedModel` from `lib/ai/resolve.ts`; `isAdminUserId` from `lib/admin.ts`.
- Produces: `creditRefusal(userId: string, roles: readonly ResolvedModel[], now: Date = new Date()): Promise<Response | null>`. It returns `null` without querying when every role is `keyOwner: "user"` or the user is an admin. Otherwise it returns `null` when `creditsLeft(spend) >= 1`, and else `Response.json({ code: OUT_OF_CREDITS, resetsAt: nextReset(now).toISOString() }, { status: 402 })`.

- [ ] **Step 1: Write the failing tests.** Mock `@/lib/db/credits` (`getAppSpendUsd` as `vi.fn`) and `@/lib/admin` (`isAdminUserId` as `vi.fn`, default false).

```ts
const app = { model: "anthropic/claude-haiku-4.5", id: "anthropic/claude-haiku-4.5", keyOwner: "app" } as const;
const user = { ...app, keyOwner: "user" } as const;
const now = new Date("2026-11-20T10:00:00Z");

it("refuses at zero credits with 402 and the reset date", async () => {
  spend.mockResolvedValue(5);
  const res = await creditRefusal("u1", [app], now);
  expect(res?.status).toBe(402);
  expect(await res?.json()).toEqual({ code: "out_of_credits", resetsAt: "2026-12-01T00:00:00.000Z" });
  expect(spend).toHaveBeenCalledWith("u1", new Date("2026-11-01T00:00:00Z"));
});
it("allows one credit left", async () => { spend.mockResolvedValue(4.99); expect(await creditRefusal("u1", [app], now)).toBeNull(); });
it("checks mixed roles", async () => { spend.mockResolvedValue(6); expect((await creditRefusal("u1", [user, app], now))?.status).toBe(402); });
it("skips users whose key covers every role, without querying", async () => {
  expect(await creditRefusal("u1", [user, user], now)).toBeNull();
  expect(spend).not.toHaveBeenCalled();
});
it("skips admins", async () => { admin.mockReturnValue(true); spend.mockResolvedValue(50); expect(await creditRefusal("u1", [app], now)).toBeNull(); });
```

- [ ] **Step 2: Run `npx vitest run lib/ai/creditGate.test.ts`.** Expected: FAIL, because the module isn't found.
- [ ] **Step 3: Implement `creditRefusal` in `lib/ai/creditGate.ts`.**
- [ ] **Step 4: Run `npx vitest run lib/ai/creditGate.test.ts`.** Expected: PASS.
- [ ] **Step 5: Wire the routes.**
  - Draft passes every role, because `researchedDraftInput` gets the whole set: `const refused = await creditRefusal(userId, [models.outline, models.content, models.chat, models.research, models.allocate]); if (refused) return refused;`
  - Chat passes `[models.chat, models.outline]`, the chat model and the revision tool's model.
  - Don't touch `app/api/plan/expand/route.ts`, `expandNodeAction`, or `generateLeafContentAction`.
- [ ] **Step 6: Run `npx vitest run && npx tsc --noEmit`.** Expected: all tests pass and there are no type errors.
- [ ] **Step 7: Commit** with the message `feat(credits): refuse a new draft or chat turn at zero credits`.

### Task 4: The refusal reaches the workspace as an alert

**Files:**
- Modify: `lib/ndjson.ts`, in `readNdjson`'s `!response.ok` branch
- Test: `lib/ndjson.test.ts`
- Create: `components/pensieve/OutOfCreditsAlert.tsx`
- Modify: `components/pensieve/ConversationRail.tsx`, to add a `notice` slot after the message list
- Modify: `components/pensieve/PlanWorkspace.tsx`, in the draft catch, the chat catch, the top of the left column and the `ConversationRail` props
- Reference: `docs/mockups/free-credits.html`, sections 3 and 4

**Interfaces:**
- Consumes: `OUT_OF_CREDITS`, `formatReset` (Task 1).
- Produces:
  - `readNdjson` on a non-OK response whose body parses as JSON with `code === OUT_OF_CREDITS` throws `Object.assign(new Error("You've used this month's free credits."), { code: OUT_OF_CREDITS, resetsAt })`. Every other non-OK response behaves exactly as today.
  - `OutOfCreditsAlert({ resetsAt, onClose, onRetry }: { resetsAt: string; onClose?: () => void; onRetry?: () => void })`. Pass exactly one of the two callbacks.
  - `ConversationRail` gains an optional `notice?: ReactNode` prop.

- [ ] **Step 1: Write the failing tests** in `lib/ndjson.test.ts`:

```ts
it("turns a 402 out-of-credits body into an error with its code and reset", async () => {
  const res = Response.json({ code: "out_of_credits", resetsAt: "2026-12-01T00:00:00.000Z" }, { status: 402 });
  await expect(readNdjson(res, () => {})).rejects.toMatchObject({ code: "out_of_credits", resetsAt: "2026-12-01T00:00:00.000Z" });
});
it("keeps plain-text failures as before", async () => {
  await expect(readNdjson(new Response("Not authenticated", { status: 401 }), () => {})).rejects.toThrow("Not authenticated");
  await expect(readNdjson(new Response("oops", { status: 402 }), () => {})).rejects.toThrow("oops");
});
```

- [ ] **Step 2: Run `npx vitest run lib/ndjson.test.ts`.** Expected: the first new test FAILS. The second passes already; it guards the old behaviour.
- [ ] **Step 3: Implement the `readNdjson` branch.** Read the text once, try `JSON.parse` in a try/catch, and fall back to today's `throw new Error(text || …)`.
- [ ] **Step 4: Run `npx vitest run lib/ndjson.test.ts`.** Expected: PASS.
- [ ] **Step 5: Build `OutOfCreditsAlert`** to match sections 3 and 4 of `docs/mockups/free-credits.html`, with `Button` from `components/ui`.
  - The look: `bg-neutral-100` on the page, a ring in the primary colour at about 35%, the medium shadow, a round `bg-accent-200` badge with lucide `Coins`, and the title in `font-heading`.
  - The copy is fixed by the spec:

```
You've used this month's free credits
Your credits reset on {formatReset(new Date(resetsAt))}. Upgrade for more, or add your own API key to keep going now.
[Upgrade → /settings#credits]  [Add API key → /settings#api-key]
Opens in a new tab, so this draft stays here.        (small, muted, under the buttons)
```

  - Upgrade and Add API key are `<Link target="_blank" rel="noopener">` rendered through `Button`'s `render` prop with `nativeButton={false}`, as `app/page.tsx` does for "+ New track". Each has lucide `ExternalLink` at `size-3`. Upgrade is the primary button and Add API key the secondary one.
  - **Two variants, set by which callback is passed:**
    - `onClose` (the chat variant): a ✕ icon button in the header's top right, `aria-label="Close"`. The card is compact (`p-3.5`, title about 17 px).
    - `onRetry` (the draft variant): no ✕. A third secondary button, `Try again`, calls `onRetry`. The body gains the sentence `Your answers above are kept, so you can draft this plan as soon as you're ready.` The card is roomier (`p-6`, title about 20 px).

- [ ] **Step 6: Give `ConversationRail` a slot for a notice.** Add an optional prop `notice?: ReactNode`, rendered after the `messages.map(...)` list and before the input. Nothing else in the rail changes.

- [ ] **Step 7: Wire `PlanWorkspace`.**
  - Add `const [outOfCredits, setOutOfCredits] = useState<{ resetsAt: string; from: "draft" | "chat" } | null>(null)`.
  - Clear it everywhere `setErrorCode(null)` runs.
  - In the draft catch and the chat catch, when `(err as { code?: unknown }).code === OUT_OF_CREDITS`, call `setOutOfCredits({ resetsAt: err.resetsAt, from })`. Don't set `error`, and don't append the chat `sys` message.
  - **Draft refusal:** the alert takes the plan's place at the top of the left column, where `ResearchProgress` would be, with `onRetry={() => void streamDraft()}`. Keep the plan label and the two empty placeholder rows under it, as the research view shows them. The existing Try again button by Confirm plan doesn't render for this error, because `error` stays null.
  - **Chat refusal:** pass `notice={outOfCredits?.from === "chat" ? <OutOfCreditsAlert resetsAt={…} onClose={() => setOutOfCredits(null)} /> : undefined}` to `ConversationRail`. If the rail is closed when the refusal arrives, open it the way an incoming reply does (the existing `unread` and `railOpen` handling).
  - Don't render the alert by the error paragraph under Confirm plan.
  - Leave `codeOf` and `KEY_ERRORS` alone.
- [ ] **Step 8: Run `npx vitest run && npx tsc --noEmit && npm run lint`.** Expected: clean.
- [ ] **Step 9: Commit** with the message `feat(credits): show the out-of-credits alert on draft and chat`.

### Task 5: Credits on Settings and in the top bar

**Files:**
- Create: `lib/db/creditStatus.ts`
- Test: `lib/db/creditStatus.test.ts`
- Create: `app/settings/CreditsCard.tsx`
- Modify: `app/settings/page.tsx`. The column becomes Credits, API key, Account. A wrapper `id="api-key"` goes on the key card, and the subtitle changes.
- Modify: `components/pensieve/TopBar.tsx`

**Interfaces:**
- Consumes: Tasks 1 and 2 (including `keyCoversAll` from `lib/ai/resolve.ts`), plus `getUserApiKeys` (`lib/db/userApiKeys.ts`).
- Produces: `getCreditStatus(userId: string, now: Date = new Date()): Promise<{ left: number; allowance: number; resetsAt: Date; keyCoversAll: boolean }>`. `allowance` is `MONTHLY_FREE_CREDIT_USD * CREDITS_PER_USD`, which is 500. `keyCoversAll` is `keyCoversAll(rows.map((r) => r.provider))`.

- [ ] **Step 1: Write the failing test** with the pglite mock: a user with $1.234 of app spend this month and no key gets `{ left: 376, allowance: 500, keyCoversAll: false }`. After `upsertUserApiKey` for `anthropic`, `keyCoversAll` is `true`.
- [ ] **Step 2: Run `npx vitest run lib/db/creditStatus.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement `getCreditStatus`.**
- [ ] **Step 4: Run `npx vitest run lib/db/creditStatus.test.ts`.** Expected: PASS.
- [ ] **Step 5: Build `CreditsCard({ left, allowance, resetsAt, keyCoversAll })`** with `id="credits"`, to match section 2 of `docs/mockups/free-credits.html`.
  - Use the Settings card style from Global Constraints and the existing `Progress` from `components/ui` (value `left / allowance × 100`).
  - Show `{left}` large, in `font-heading` at about 30 px, followed by the line below. The reset sits at the row's right.
  - At `left === 0`, the number is `text-red-600`.
  - The copy:
  - Title: `Credits`
  - Line: `{left} of {allowance} credits left this month · resets {formatReset(resetsAt)}`
  - When `keyCoversAll`: `Your API key pays for your usage, so these credits are only used if a call runs on Pensieve's key.`
  - When `left === 0` and not `keyCoversAll`: `New plans and plan chat are paused until {formatReset(resetsAt)}. Your plans, lessons and filling in weeks keep working. Add an API key below to keep going now.`
  - Phase 1 upgrade note: `Paid plans with more credits are coming.`
- [ ] **Step 6: Update the Settings page.**
  - Change the subtitle to `Pensieve pays for your usage up to your monthly credits. Add an API key to pay for your own.`
  - Add `getCreditStatus(userId)` to the page's existing `Promise.all` with `getUserApiKeys` and `currentUser`.
  - Render `CreditsCard` first in the `flex flex-col gap-5` column.
- [ ] **Step 7: Add a credits pill to `TopBar`,** just before the streak pill, when `userId && !status.keyCoversAll`.
  - It's a `Link` to `/settings#credits` with the streak pill's shape: `inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12.5px] font-semibold`. Use a neutral colour (`bg-neutral-100 text-neutral-700`), so it doesn't read as a second streak. Use lucide's `Coins` icon at `size-3.5`.
  - It shows `{left}`, with `title` and `aria-label` set to `{left} credits left this month`.
  - At `left === 0` it uses the warning text colour the app already uses for errors (`text-red-600`), so the state is visible before a refusal.
  - Fetch the status in parallel with the streak query (`Promise.all`).
  - *(My call: a pill next to the streak keeps the bar's one row and works down to 640 px. A link in the account menu would hide the number behind a click.)*
- [ ] **Step 8: Run `npx vitest run && npx tsc --noEmit && npm run lint`.** Expected: clean.
- [ ] **Step 9: Commit** with the message `feat(credits): show the balance on Settings and in the top bar`.

### Task 6: Migrate and check it live

**Files:** none changed, except a temporary change to the constant that is never committed.

- [ ] **Step 1: Ask the user before migrating.** Explain that `npx drizzle-kit migrate` applies `0016` (one `CREATE INDEX`) to the shared Neon database, which is production too. Run it only after a clear yes. Expected: the migration applies, and `drizzle.__drizzle_migrations` has the new row.
- [ ] **Step 2: Start the app from the worktree on port 3001,** detached with `nohup`, as in the project's live-test practice, and check it in a fresh Chrome tab. A signed-in, non-admin test user is needed. If the only signed-in user is an admin, temporarily take that ID out of `ADMIN_USER_IDS` in the local env for this check and restore it afterwards.
- [ ] **Step 3: With `MONTHLY_FREE_CREDIT_USD` temporarily set so the user has about 50 credits left,** start a draft. Confirm that:
  - the draft finishes even though it drives the balance below zero;
  - the top bar's credits pill then shows `0` in red, and still fits at 640 px wide;
  - a later week still expands;
  - a chat turn shows the compact alert in the conversation, under the refused message, with the reset date;
  - **Add API key** opens Settings in a new tab, with no leave-page prompt, and the draft is still on the original tab;
  - Settings shows the 0-left Credits card with its "paused until" line;
  - a new draft is refused with the larger alert at the top of the plan area, and **Try again** sends the draft again.
- [ ] **Step 4: Restore the constant to `5`.** Run `git diff` and expect no change to `lib/credits.ts`.
- [ ] **Step 5: Report the results with a screenshot of the alert.**
