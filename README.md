# Pensieve

**An AI study planner. Tell it what you want to learn and how much time you have; it researches the topic, keeps only
materials it could check are real, and builds a day-by-day plan you can follow and change by chatting.**

[Live app](https://pensieve-mvp-green.vercel.app) · [What it does](#what-it-does) ·
[Engineering highlights](#engineering-highlights) · [Tech stack](#tech-stack) · [Run it locally](#run-it-locally)

<!--
  Demo video goes here. On github.com, edit this file and drag the .mp4 (under 10 MB on a free plan) onto this spot.
  GitHub uploads it and inserts a https://github.com/user-attachments/assets/… link; keep that link on a line of its
  own and it plays inline. Do not commit the video to the repository.
-->

## What it does

1. **Set a goal.** What you want to learn, how many hours a week, and which days. Add your own links or notes if you
   have them.
2. **It researches.** An AI agent searches the web and reads sources while you watch its progress. A material enters
   the plan only if code fetched it and confirmed it is what the model said it is; books are checked against the Open
   Library catalogue.
3. **It drafts a plan.** Weeks and days, each with what to read and what to practise, sized to the time you have.
4. **Change it by chatting.** "Make week 3 lighter", "add more practice problems": the plan is revised, the changed
   parts are highlighted, a change can be undone, and days you have already completed stay locked.
5. **Study day by day.** Each day has its reading, practice tasks and a generated lesson. Mark it complete and your
   streak and activity heatmap update across all your tracks.

Already have a plan? Drop a `.md` or `.txt` file and Pensieve imports it as written.

The live app is free to sign up for: every account gets $5 of model use a month, or you can add your own Anthropic
key. A researched draft takes a few minutes.

## Engineering highlights

### A research agent whose output is checked in code, not trusted

The research step ([`lib/ai/research/`](lib/ai/research)) runs the model in a tool loop (search the web, fetch a page,
read its outline) or, as production does, as workers running in parallel under one deadline: one each for the main
resource, canonical references and current material, plus one for practice sources when the plan has practice.
Nothing goes into a plan on the model's say-so. The
[verification gate](lib/ai/research/verify.ts) keeps a material only if code fetched it during this run and the page
is what the model claimed; a title that does not match drops the material instead of being corrected. Books, rarely
readable online, are checked against the Open Library catalogue under one shared rate limit. The server signs each
verified material with an HMAC ([`signature.ts`](lib/ai/research/signature.ts)), so a "verified" badge cannot be forged
from the browser, and saving a plan checks the signature again.

### Evals and benchmarks make the decisions

- **A rubric grounded in real failures.** [`evals/rubric.md`](evals/rubric.md) has eight pass/fail dimensions for LLM
  judges, each traced to a cluster of failures found by
  [open-coding real outputs](evals/analysis/2026-09-16-open-coding.md). Anything code can check (lengths, order,
  unknown material ids, locked units) is a code check, not a judge.
- **End-to-end evals.** [`evals/draft/`](evals/draft) runs the full research-and-draft pipeline on eleven topics with
  known right answers and reports pass rate, latency and cost per run.
  [`evals/research/`](evals/research) compared the shipped tool loop with Anthropic's server-side web tools and with
  the parallel-worker design, on the same verification gate and judges.
- **Model benchmarks.** [`benchmarks/`](benchmarks) grades which models can do each job, with an error bar, a cost and
  a latency per model.
- **One finding that shipped:** Claude models served through Google Vertex did no reasoning on structured-output calls
  (0 reasoning tokens, against 600–1,200 on Anthropic's API), and Haiku 5.5's outline scores fell from 0.87–1.00 to
  0.07–0.64. Those models are now pinned to the providers measured to reason
  ([`lib/ai/models.ts`](lib/ai/models.ts)).

### Plans you change by talking

[Plan chat](lib/ai/planChat.ts) runs on a fast model with tools: it answers questions itself and hands real changes to
a revision call on the stronger planning model, or re-drafts part of the plan. Completed days are locked, so a
revision cannot rewrite what you have already done, and every change is shown and can be undone.

### Long AI work, streamed

A researched draft runs for minutes. The [draft route](app/api/plan/draft/route.ts) streams progress as NDJSON (what
was searched, which sources were kept and which were dropped and why) and keeps the whole draft inside its own time
budget, under Vercel's 300-second function limit, dropping what does not fit rather than timing out.

### Cost control and bring-your-own-key

Every model call is logged with what the AI Gateway charged for it ([`lib/ai/logged.ts`](lib/ai/logged.ts)). A user's
monthly allowance is worked out from that log, with no stored balance to drift ([`lib/credits.ts`](lib/credits.ts)).
Users can add their own Anthropic key instead: calls on it skip the gateway and the allowance. Keys are encrypted at
rest with AES-256-GCM, a fresh IV per key and a version number so the server secret can rotate
([`lib/secrets.ts`](lib/secrets.ts)).

### Shipping safely

- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) type-checks, lints, runs 2,100+ tests and fails a
  pull request that changes the database schema without its migration.
- **Deploys:** every branch gets a Vercel preview with its own Neon database branch; a merge to `main` deploys
  production.
- **Migrations** run in the production build after `next build` succeeds, and the deployment goes live only if they
  succeed too. Every migration has to work with the code already serving (expand first, contract in a later release);
  the rules are in [`docs/operations.md`](docs/operations.md#migrations).

### Built from written designs

Larger features start as a design spec and a step-by-step implementation plan
([`docs/superpowers/specs/`](docs/superpowers/specs), [`docs/superpowers/plans/`](docs/superpowers/plans)).
[`docs/case-studies/`](docs/case-studies) has the AI-assisted study-planning session the product grew out of.

## Tech stack

| Area | Choice |
|---|---|
| App | Next.js 16 (App Router, server actions), React 19, TypeScript |
| AI | Vercel AI SDK 7 through the Vercel AI Gateway. Claude Opus 5.5 plans, Sonnet 5.5 researches, Sonnet 5 writes lessons, Haiku 4.5 chats |
| Research | Tavily web search, Open Library catalogue |
| Data | Neon Postgres, Drizzle ORM and migrations |
| Auth | Clerk |
| UI | Tailwind CSS 4, shadcn/ui on Base UI |
| Testing | Vitest, PGlite for database tests, custom evals and model benchmarks |
| Delivery | GitHub Actions, Vercel |

## Run it locally

You need Node 22 or later, a [Neon](https://neon.tech) Postgres database, a [Clerk](https://clerk.com) application and
a [Vercel AI Gateway](https://vercel.com/ai-gateway) key.

```bash
git clone https://github.com/misterbig030/pensieve.git
cd pensieve
npm install
```

Create `.env.local`:

```bash
DATABASE_URL=postgres://...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
AI_GATEWAY_API_KEY=...
USER_KEY_ENCRYPTION_SECRET=...   # openssl rand -base64 32
TAVILY_API_KEY=...               # optional: without it, plans draft from your own sources only
```

Then create the tables and start the app on http://localhost:3000:

```bash
npx drizzle-kit migrate
npm run dev
```

`npm test` runs the test suite; it needs no keys, since the tests mock every model, database and network call. The
other settings, user credits, deployment and migration rules are in [`docs/operations.md`](docs/operations.md).

## Project layout

```
app/                 pages (home, new track, track, adjust, day, settings) and the plan API routes
lib/ai/              model calls: drafting, revision, plan chat, daily lessons
lib/ai/research/     the research agent and its verification gate
lib/import/          importing an existing plan file
lib/db/              Drizzle schema and queries
evals/               eval harness, rubric, golden sets
benchmarks/          model benchmarks
docs/                design specs, implementation plans, operations
```
