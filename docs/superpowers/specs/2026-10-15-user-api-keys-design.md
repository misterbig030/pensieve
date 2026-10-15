# User API keys: a user's own key pays for their usage

**Status:** designed on 2026-10-15; not built. Plan: pending.

## Summary

A signed-in user can store their own provider API key. From then on every model call made on their behalf, research,
plan drafting, daily content and plan chat, runs directly against the provider with that key, so the usage is billed to
them. A user without a key keeps using the app's Vercel AI Gateway key exactly as today. When a user's key is refused,
the request stops with a message that says why; it is never quietly retried on the app's key.

The first user is the operator, whose Claude Max plan carries monthly API credits. The feature is on for every user
from the first deploy; the app is in internal testing and has no staged rollout.

## Background: what Anthropic offers and forbids

From Anthropic's own pages, checked on 2026-10-15:

- **Max and Team plans include monthly API credits** ($100 on Max 5x, $200 on Max 20x, up to $500 pooled on Team;
  not Free, Pro or Enterprise). The subscriber links a Claude Console organization to the plan on claude.ai; credits
  land in that organization each billing cycle and "everyone with an API key in the linked organization can use the
  balance". They cover the Claude API, Managed Agents, the Agent SDK and the playground. They do not cover Claude Code,
  the Claude apps, or any third-party platform (Bedrock, Vertex, Foundry), and they apply "only to the Claude API in the
  Claude Console", so not through the Vercel gateway. When they run out, "API requests stop until your next monthly API
  credits arrive" unless the organization has purchased credits or auto-reload. Unused credits expire each cycle.
  (platform.claude.com/docs/en/about-claude/api-credits-for-subscribers; support.claude.com article 17154008.)
- **Third-party apps may not offer Claude sign-in.** "Anthropic does not permit third-party developers to offer
  Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf
  of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens."
  The same page allows what this design does: customers may provision and manage their own API keys "provided the
  resulting usage is billed to the key owner under their agreement with Anthropic".
  (code.claude.com/docs/en/legal-and-compliance.)
- **The credit terms** add only that credits "may only be used by the holder of the Anthropic account to which the
  Credits are associated", which a user spending their own key in this app satisfies.
- Anthropic's advice for a key that others could spend: "set workspace spend limits in the Console". The settings page
  passes this on.

Other vendors authenticate the same way, with a per-organization secret key, so the data model is provider-general.
Google's AI Pro and Ultra plans also include monthly credits usable on the Gemini API; OpenAI's ChatGPT plans include
none. Only Anthropic is routed in this version (decision 3).

## Goals and non-goals

Goals:

1. A user with a key pays for all their own model usage; a user without one notices nothing.
2. The key is never shown again, never logged, and useless if the database alone leaks.
3. A refused key produces a message the user can act on, on the page where it happened and on the settings page.
4. The operator can tell, per generation-log row, who paid.

Non-goals, recorded as follow-ups at the end: routing to Google or OpenAI models; a per-user choice of research model;
a usage display; a secret-rotation script.

## Decisions

1. **The user's key covers every model call made on their behalf**: research (both arms and the candidate step), plan
   drafting and expansion, daily content, plan chat. One rule to explain: your key pays for your usage.
2. **A refused key stops the request and says why.** No fallback to the app's key, automatic or per-user. The operator's
   key is not anyone's overdraft, and a user whose credits run out on the 3rd does not spend the operator's until the
   next cycle without anyone deciding that.
3. **One generic key field; the provider is detected from the key's prefix** (`sk-ant-` Anthropic, `AIza` Google,
   `sk-` or `sk-proj-` OpenAI, Anthropic checked first). Only Anthropic has a direct route in this version. A key for
   another vendor is refused with "Pensieve runs on Claude models, so this key can't be used yet. Nothing was saved."
   Each later provider is added behind the registry, gated on its own effort bench and compare run, because every
   measurement that tuned research so far is Claude-specific.
4. **Identity stays with Clerk and the env var.** There is no users table; `user_api_keys` is keyed by the Clerk id like
   every other table, and admin status stays in `ADMIN_USER_IDS`. No row has to exist before anything can reference it.
5. **Keys live in our own table, encrypted at rest**, not in Clerk metadata: a secret should not sit in a vendor's user
   record that is editable from a dashboard, and the resolver should not need a Clerk round trip per request.
6. **The model set is resolved once per request and passed down explicitly.** No request-scoped context: a call that
   forgets the model set fails type-checking instead of silently billing the app.
7. **Every generation-log row records who paid** (`key_owner`), carried by the request's log context so no row-building
   site changes.
8. **On for everyone from the first deploy.** No flag, no allowlist.

## Data model

```ts
/** The providers the model list knows, as the prefix of each model id ("anthropic/claude-sonnet-5.5"). */
export const MODEL_PROVIDERS = ["anthropic", "google", "openai"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const KEY_ERRORS = ["invalid", "credits", "rate_limit", "other"] as const;

/** A user's own API key for one provider, so their usage is billed to them. One row per user and provider. */
export const userApiKeys = pgTable(
  "user_api_keys",
  {
    userId: text("user_id").notNull(), // the Clerk id, as on tracks
    provider: text("provider", { enum: MODEL_PROVIDERS }).notNull(),
    /** AES-256-GCM with the server secret: base64 of iv + tag + ciphertext. */
    ciphertext: text("ciphertext").notNull(),
    /** Last four characters, the only part ever shown again. */
    last4: text("last4").notNull(),
    /** Which server secret encrypted it, so the secret can rotate without a flag day. Starts at 1. */
    secretVersion: integer("secret_version").notNull().default(1),
    /** The last time a request on this key was refused, and why; cleared when a request succeeds. */
    lastError: text("last_error", { enum: KEY_ERRORS }),
    lastErrorAt: timestamp("last_error_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.provider] })],
);
```

Removing a key deletes the row, so there are no nullable key columns. The enums are TypeScript-only, as drizzle text
enums are, so adding a provider or an error kind later needs no migration.

`generation_log` gains one column: `key_owner: text({ enum: ["app", "user"] }).notNull().default("app")`. Existing rows
read as `app`.

Deliberately absent: a "last used" timestamp (a write per model call); anything about the user's plan, which the app
cannot know and does not need; a key for any provider without a route.

Migration `0009_user_api_keys.sql`: the table and the column. Generated with drizzle-kit in the operator's terminal
(it needs a TTY) and applied by the operator before the deploy: old code with the new column is fine because of the
default; new code with the old column fails on its first log insert.

## Encryption: `lib/secrets.ts`

Two functions over AES-256-GCM from Node's `crypto`, no new dependency:

- `sealSecret(plaintext): { ciphertext, version }`: a 32-byte key from `USER_KEY_ENCRYPTION_SECRET` (base64), a fresh
  random 12-byte IV per call, output base64 of `iv || tag || ciphertext`, version 1.
- `openSecret(ciphertext, version): string`: fails loudly on a wrong secret, a tampered row or an unknown version;
  never returns garbage.

A missing or malformed env var is an error at the first call, never a silent fallback to plaintext. The decrypted key
exists only in server memory for the duration of one request, inside the provider instance the resolver builds. It is
never logged, never returned to the browser, and never part of a `ModelCall` record.

## Queries: `lib/db/userApiKeys.ts`

`getUserApiKeys(userId)` (all rows for a user: the resolver's one read), `upsertUserApiKey(userId, provider, ciphertext,
last4, version)` (clears any error), `deleteUserApiKey(userId, provider)`, `recordUserApiKeyError(userId, provider,
kind)`, `clearUserApiKeyError(userId, provider)`.

## Resolving models: `lib/ai/resolve.ts`

```ts
interface ResolvedModel {
  model: AiModelId | LanguageModel; // the gateway id string, or a direct instance built from the user's key
  id: AiModelId;                    // always the gateway-style id, for logging and pricing
  keyOwner: "app" | "user";
}
interface ModelSet { outline: ResolvedModel; content: ResolvedModel; chat: ResolvedModel; research: ResolvedModel }

/** Pure: the defaults, the user's decrypted keys by provider, and the registry decide each model. */
export function resolveWith(defaults: Record<keyof ModelSet, AiModelId>, keys: Partial<Record<ModelProvider, string>>, registry = DIRECT_PROVIDERS): ModelSet;
/** One query, decrypt in memory, then resolveWith. Called once per request, right after auth(). */
export async function resolveModels(userId: string): Promise<ModelSet & { keyErrors: Partial<Record<ModelProvider, boolean>> }>;
```

The decision per model: the id's prefix is the provider; a user key for that provider plus a registered factory gives a
direct instance; otherwise the gateway id. `keyErrors` says which stored keys have an error recorded, so a later clear
is a single conditional write.

**The registry**, `DIRECT_PROVIDERS: Partial<Record<ModelProvider, { create(apiKey): Provider; apiIds: Record<AiModelId, string> }>>`.
Anthropic is the only entry: `createAnthropic({ apiKey })` from `@ai-sdk/anthropic`, already installed, and the id map

| gateway id | Anthropic API id |
|---|---|
| `anthropic/claude-haiku-4.5` | `claude-haiku-4-5` |
| `anthropic/claude-sonnet-5` | `claude-sonnet-5` |
| `anthropic/claude-sonnet-5.5` | `claude-sonnet-5-5` |
| `anthropic/claude-opus-5` | `claude-opus-5` |
| `anthropic/claude-opus-5.5` | `claude-opus-5-5` |

A test iterates the model list and fails if an Anthropic id has no mapping. Google and OpenAI have no entry; a key for
them is refused at save time (decision 3), so the resolver never sees one.

**Effort is unchanged.** `RESEARCH_LOOP_EFFORT` and `CANDIDATE_STEP_EFFORT` stay in `lib/ai/models.ts`; the
`providerOptions.anthropic.effort` option is the same field on a direct instance as through the gateway.

**Who receives the set.** The draft, expand and chat API routes and the daily-content server action call
`resolveModels(userId)` after `auth()` and pass the relevant `ResolvedModel` down. The library functions stop importing
default ids: `streamPlanDraft` and `streamResearchedPlanDraft` take the outline and research models, `planChat` the
chat model, `dailyContent` the content model, and `defaultArm()` takes the research model. The eval scripts and tests
keep passing gateway ids, which resolve to today's behaviour. `loggedGenerateObject` already accepts a `languageModel`
instance beside the id; the research loop and arms already accept instances.

**Logging.** `GenerationLogContext` gains `keyOwner`, defaulting to `app`, so every row built in the request records it
without touching the row-building sites. `ResolvedModel.id` keeps pricing keyed by gateway ids even when the call went
direct. No cache across requests: a removed key stops being used on the next request; a request in flight finishes on
the key it started with.

## Settings page: `/settings`

Reached from a "Settings" link in the top nav, visible to every signed-in user. One card per provider the registry can
route, so one card in this version. States:

- **No key.** Title "API key". Copy: "Pensieve runs on Claude models, so the key has to be an Anthropic key for now.
  Claude Max and Team plans include monthly API credits; Pro and Free don't, but a key with a card behind it works the
  same way." A password-type input and Save. A collapsed "How to get a key that spends your plan's credits" with three
  steps: link a Console organization under Settings → Billing → API credits on claude.ai; in the Console, signed in with
  the same email, create a workspace for Pensieve with a spend limit, because any key in the organization can spend the
  whole balance; create a key in that workspace and paste it. A closing line: when credits run out, generations stop
  with a message rather than falling back to Pensieve's key; add credits or turn on auto-reload in the Console.
- **Another vendor's key pasted.** The field keeps the value, nothing is saved, and under it: "That looks like an
  OpenAI key. Pensieve runs on Claude models, so it can't be used yet. Nothing was saved." (Vendor named from the
  detected prefix; "That key isn't one Pensieve recognises" when no prefix matches.)
- **Key stored, working.** "Anthropic key ending in …k9Qa · added 15 Oct 2026" with Remove, and "To change keys, remove
  this one and save another. The key itself is never shown."
- **Key stored, last request refused.** The same row under a warning: "Last request refused 2 hours ago: credits
  exhausted. Anthropic stopped requests until your next monthly credits arrive. Add credits or turn on auto-reload in the
  Console, or remove the key to use Pensieve's." The wording follows the error kind (invalid, rate-limited, other).

Mockups from the brainstorm are under `.superpowers/brainstorm/` (ignored).

**Server actions, `app/settings/actions.ts`**, in the style of the track actions: `auth()` first, zod on every input.

- `saveApiKeyAction({ key })`: detect the provider from the prefix; refuse unknown or unrouted providers with the
  messages above; verify the key against the provider with a call that costs nothing (Anthropic: `GET /v1/models`, 200
  means valid, 401 means not); on success seal, upsert with the last four and a cleared error, revalidate `/settings`;
  on failure return a plain error ("That key was not accepted by Anthropic") and store nothing. This proves the key, not
  the balance; whether credits remain shows up on the first real request.
- `removeApiKeyAction({ provider })`: delete the row.

Neither action ever returns the key. There is no edit: a user with a different key removes and saves.

## The failure path

Every model call goes through the AI SDK, which throws `APICallError` with the status code and response body. The app
already carries errors to the user: the NDJSON stream turns a thrown error into `{ type: "error", message }` and the plan
workspace renders it; server actions throw and their pages show the message.

`classifyProviderError(error): KeyErrorKind` maps the SDK error: 400 whose body says the credit balance is too low →
`credits`; 401 → `invalid`; 429 → `rate_limit`; anything else → `other`. It is applied only when the request's log
context says `keyOwner: "user"`; gateway calls keep today's behaviour. The result is a `UserKeyError` carrying the kind,
the provider and a message for the user:

- credits: "Your Anthropic credits are exhausted, so this stopped. Add credits in the Console or remove your key in
  Settings to use Pensieve's."
- invalid: "Anthropic rejected your key. Replace it in Settings, or remove it to use Pensieve's."
- rate_limit: "Anthropic is rate-limiting your key. Try again in a minute."
- other: "Anthropic returned an error for your key (status N). Try again; if it keeps happening, check the Console."

The stream's error event gains an optional `code` (the kind) so the workspace shows the message with a link to
Settings. Server actions throw the same error. On a `UserKeyError` the route or action records the kind and time on the
key's row, fire-and-forget. On the first request that completes on a key with an error recorded, the error is cleared.

Not done: no retry on the app's key (decision 2); no partial fallback, since the drafting that follows research would
run on the same key and fail the same way, so the request stops at the first refusal; no generation-log row for a failed
call, which is today's behaviour.

## Testing

Test-first throughout.

- **Pure units.** `sealSecret`/`openSecret`: round trip, tampered ciphertext fails, wrong secret fails, missing env var
  fails loudly. `detectProvider`: each prefix, `sk-ant-` before `sk-`, unknown → null. `resolveWith`: no keys → gateway
  ids with `keyOwner: "app"`; an Anthropic key → direct instances with the vendor ids and `keyOwner: "user"`; a key for
  an unregistered provider → gateway; every Anthropic id in `AVAILABLE_MODELS` has a mapping. `classifyProviderError`:
  the four kinds from fabricated `APICallError`s.
- **Database**, against the repo's test database: upsert stores ciphertext and last four and never the plaintext;
  read, delete, record and clear behave as specified. The save action's validation with the provider check mocked.
- **Pipeline.** One test per surface: a credits refusal from a user-key model reaches the client as the error event with
  the right code and message; the same failure on a gateway call keeps today's plain message. The NDJSON helper's test
  covers `code`.
- **In the operator's Chrome before the PR**, since the repo has no component tests: the settings states; a draft on the
  operator's own key shows `key_owner: user` on every row and appears on the Console cost page; a draft after removing
  the key does not.

## Mechanics

- **Env:** `USER_KEY_ENCRYPTION_SECRET`, 32 random bytes as base64 (`openssl rand -base64 32`), set in Vercel and in
  `.env.local`. The README's env list gains the line.
- **Migration first, deploy second** (see Data model).
- **Search stays on the app's key.** Tavily and the catalogue lookup are not model calls; a user's draft still costs
  the app a few search credits.

## Follow-ups, not in this version

- **Google, then OpenAI routes.** Each needs: its provider package, a registry entry, a role-to-model table (the model
  list already prices three models per vendor), its own effort option (`providerOptions.openai.reasoningEffort` for
  OpenAI), a check of the structured-output schemas against the vendor's strict mode, and an effort bench plus compare run
  before its keys are accepted. Google AI Pro and Ultra carry monthly Gemini API credits, so Google first.
- **Per-user research model**, e.g. Opus 5.5 for a key holder, once the compare has numbers for it.
- **A secret-rotation script**: re-encrypt rows from version N to N+1; the column exists for it.
- **A usage display** is the Console's job; the page says so.

## Open items

- The models endpoint proves the key, not the balance. If first-draft failures on fresh keys turn out common, a tiny
  paid probe at save time (one Haiku token) would show "credits available" too.
- Whether `other` should include Anthropic's 529 overloaded responses as retryable rather than refusing; decide from the
  first weeks' `last_error` rows.
