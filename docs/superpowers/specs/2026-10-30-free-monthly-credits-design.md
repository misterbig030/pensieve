# Free monthly credits: a limit on what Pensieve pays for each user

**Status:** design, not built. Phase 1 of two; phase 2 (paid plans) is outlined at the end and not designed here.

## Summary

Every signed-in user gets the same monthly credit allowance, worth $5 of model cost, shown in the UI as 500 credits.
Each model call Pensieve pays for (through the Vercel AI Gateway) uses up credits equal to its cost. Calls on a user's
own API key use none. Before a new plan draft or a chat turn starts, the app checks the user's balance. At zero or
below, it does not start, and an alert says the month's credits are used up and offers an upgrade. Continuing work the
user already has (filling in a plan's later weeks, opening a day's lesson) is never blocked. An action that has started
always finishes. Either can take the balance below zero. The allowance resets at the start of each calendar month, and
any negative balance is wiped.

## Why

Today a user without their own key costs Pensieve whatever they use, with no limit. One plan draft costs about
$1.30–2 (the draft eval's example run is $1.31; its warning limit is $2, `evals/draft/checks.ts`). A user can run up an
unbounded bill, and in phase 2 there is nothing to charge against. The allowance caps Pensieve's cost per free user per
month and sets up the place where a paid plan will plug in.

## Goals, non-goals, anti-goals

Goals:

1. A user on Pensieve's key can't start a new plan draft or a chat turn once their month's allowance is used up, and
   can always keep studying the plans they already have.
2. A user can always see how many credits they have left and when they reset.
3. The allowance size is one constant, so changing it is a one-line change.
4. Users with their own key notice nothing new except their balance not moving.

Non-goals (phase 1):

- Taking payment, paid plans or top-ups (phase 2).
- Showing an estimate like "about 4 drafts left". The UI shows credits only.
- Making the cost measurement more accurate than it is today (see follow-ups).
- Different allowances for different users.

Anti-goals, which would make this a failure even if it technically works:

- A draft, expansion or chat reply that stops halfway because credits ran out mid-action.
- A user who can't open tomorrow's lesson, or fill in next week, on a plan they already have.
- A refusal that looks like an error or a broken app, instead of a clear "credits used up" with what to do next.
- Quietly switching a user who is out of credits onto a worse model or a smaller draft.

## Decisions

### 1. The balance is derived from `generation_log`, with no new ledger

`generation_log` already has one row per model call, with `user_id`, `key_owner`, `cost_usd` and `created_at`. A
user's spend this month is:

```sql
select coalesce(sum(cost_usd), 0) from generation_log
where user_id = $1 and key_owner = 'app' and created_at >= $monthStart
```

remaining = allowance − spend. This needs no new table and no write path beyond what exists. The monthly reset and
wiping a negative balance both happen automatically: a new month just sums a new window. *(My call. A ledger table
becomes necessary in phase 2, when purchases and grants that differ per user need records of their own; see phase 2.)*

Add an index on `generation_log (user_id, created_at)` so the sum stays fast as the table grows.

### 2. Credits, allowance and the month

- **1 credit = $0.01 of cost** as recorded in `cost_usd`. The allowance is `MONTHLY_FREE_CREDIT_USD = 5`, which is
  500 credits, in one constant in a new `lib/credits.ts`. *(The $5 is the user's decision. A code constant instead of
  an env var is my call: it's reviewed and tested like other limits in `lib/ai/models.ts`.)*
- Credits are shown as whole numbers, rounded down (499.6 shows as 499). A negative balance shows as 0.
- **The month is the calendar month in UTC.** Reset is 00:00 UTC on the 1st. *(My call: the same for every user, and
  derivable from the clock with no per-user state.)*
- The cost is the existing `cost_usd`, from `estimateCostUsd` at the model's list price. The gateway charges list price
  with no markup, so this tracks what Pensieve pays closely enough for phase 1. Known gaps are listed under follow-ups.

### 3. Only new drafts and chat are checked, and only before they start

Plans are built in steps. A new draft plans only its first week in detail. Each later week is filled in by an expand,
and each day's lesson is generated when the user opens it. **Running out blocks starting something new, never
continuing what the user already has** (the user's decision). The five entry points that make model calls:

| Entry point | File | Checked |
|---|---|---|
| Plan draft (research, allocation, outline) | `app/api/plan/draft/route.ts` | **yes** |
| Plan chat (and the revision it can trigger) | `app/api/plan/chat/route.ts` | **yes** |
| Expand from the draft page | `app/api/plan/expand/route.ts` | no |
| Expand or split a node in a track | `app/tracks/[id]/actions.ts`, `expandNodeAction` | no |
| Daily content for a leaf | `app/tracks/[id]/nodes/[nodeId]/actions.ts`, `generateLeafContentAction` | no |

The two checked routes check after `auth()` and `resolveModels()`, before any model call. The rule: **if every role
the route uses resolves to the user's own key, skip the check. Otherwise, refuse when remaining ≤ 0.** Today every
default model is Anthropic, so a user with an Anthropic key never reaches the check. Checking per role keeps it correct
if a role ever moves to a provider the user has no key for.

Once a check passes, the action runs to completion and every call is logged as today, even if the balance goes
negative partway through. Unchecked actions are logged the same way and keep using up credits after zero. So the
overdraft is not bounded by one action: it's one draft (about $2) plus whatever it costs to fill in and study the
user's existing plans that month. Expands run on the outline model (Opus 5.5) and lessons on Sonnet 5. This soft limit
is deliberate. The `generation_log` data will show how far past zero users actually go, and a hard ceiling is a
follow-up if it's needed.

Users in `ADMIN_USER_IDS` skip the check (their balance still shows). *(My call: the operator tests on Pensieve's key
and would otherwise hit the limit while working.)*

Concurrent actions are not locked in phase 1. A user with 1 credit left who starts drafts in several tabs at once
overdraws by one draft per tab. That's acceptable during internal testing; it is a follow-up before a public launch.
*(My call.)*

### 4. What a refused user sees

The refusal is a distinct result, not a key error. The `draft` and `chat` routes answer `402 Payment Required` with a
small JSON body (`{ code: "out_of_credits", resetsAt }`) before the NDJSON stream opens. `KeyErrorKind` already has
`"credits"`, which means the *provider* account behind the user's own key ran dry. Pensieve's allowance needs a
different name in the code so the two never get mixed up. *(The exact name is the builder's call.)*

The client shows one alert, in two placements (mocked in `docs/mockups/free-credits.html`, sections 3 and 4):

> **You've used this month's free credits**
> Your credits reset on 1 Dec. Upgrade for more, or add your own API key to keep going now.
> [Upgrade] [Add API key]

- **A refused chat turn** puts the alert in the conversation, under the refused message, where the user is looking.
  It closes with a ✕. The error area under Confirm plan isn't used, because after a long draft it's off screen.
- **A refused new draft** puts the alert at the top of the plan area, where the research progress would be. It adds
  "Your answers above are kept, so you can draft this plan as soon as you're ready." and has **Try again** in place
  of ✕.

- **Upgrade** goes to the Credits card on Settings. In phase 1 that card says paid plans are coming. Phase 2 replaces
  it with checkout. *(My call: the button exists now, so phase 2 changes where it goes, not the alert.)*
- **Add API key** goes to Settings, to the existing API key card.
- Both buttons open Settings **in a new tab**. On the draft page, a refusal can come from chat after a draft costing
  about $2 has already streamed in, and that draft exists only in page state. Navigating in the same tab
  would set off PlanWorkspace's "plan isn't saved yet" guard, or lose the draft. With a new tab, the user adds a key
  there, comes back, and tries the action again. *(My call: the cheapest way to keep an unsaved draft and the form
  input. Restoring page state or adding a key inline in the alert are not needed for phase 1.)*

### 5. Where credits are shown

- **Settings** gets a Credits card above the API key and Account cards: "312 of 500 credits left this month · resets
  1 Dec", with a bar (mock section 2).
  - For a user with a key, it says their key pays and credits are only used if a call runs on Pensieve's key.
  - At 0, the number turns red and the card says what is paused and what still works: "New plans and plan chat are
    paused until 1 Dec. Your plans, lessons and filling in weeks keep working." Without that line, 0 reads as if the
    whole app is locked.
  - The page subtitle "Without one, Pensieve pays." changes to say Pensieve pays up to the monthly credits.
- **The top bar** (`TopBar`, since the app shell redesign) shows the remaining credits as a small pill next to the
  streak, linking to Settings, for users on Pensieve's key. The pill turns red at 0. Users whose key covers every role
  see nothing there. *(My call: the number should be visible before a refusal, not only after one.)*
- The balance is read on the server when the page renders. It doesn't need to update live during a draft. The next
  page load shows the new figure.

## Testing

- Unit: the month window (UTC boundaries, December → January), credits from cost (rounding down, negative shows as 0),
  and the check rule (all-user-key skips, mixed roles check, admin skips, ≤ 0 refuses).
- DB (the existing pglite test setup, `lib/db/testDb.ts`): the sum counts only this month's `key_owner = 'app'` rows
  for this user.
- Draft and chat routes: a user at 0 gets the 402 and makes no model call. A user with 1 credit starts and finishes.
- Expand (both entry points) and daily content: a user below 0 still gets their result.
- Live, on the 3001 server: lower the constant to make a test user run out mid-draft. Confirm the draft finishes, its
  later weeks still expand, a chat turn is refused with the alert, and a new draft is refused too.

## Follow-ups (not phase 1)

- **Cost accuracy.** `estimateCostUsd` charges every input token at full price. In practice cache reads cost about a
  tenth of that and cache writes about a quarter more. It also doesn't count Tavily searches during research, which
  aren't model calls and aren't logged. The gateway reports each call's real cost through `providerMetadata.gateway`
  (a generation id, then `gateway.getGenerationInfo()`). Switching `cost_usd` to that is a separate change.
- **One running draft per user**, to close the multi-tab overdraft before public launch.
- **A hard ceiling on continuing work**, for example a multiple of the allowance past which expands and lessons stop
  too, if the logs show users going far below zero.
- **Abuse limits on sign-up** (Clerk email verification at minimum) before the allowance is open to the public, since
  each new account is another $5.

## Phase 2, outlined only

Paid plans: a monthly fee that includes a larger allowance, plus top-ups, through Stripe. That's when an append-only
credit ledger comes in, recording monthly grants, purchases, usage and expiry. The balance then becomes grants and
purchases minus usage, and usage still comes from `generation_log`. The alert's Upgrade button starts pointing at
checkout. Nothing in phase 1 needs to be undone for this.
