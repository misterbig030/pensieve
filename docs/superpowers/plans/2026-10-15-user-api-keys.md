# User API Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user stores their own Anthropic API key, encrypted; every model call made on their behalf then runs directly against Anthropic with that key and is billed to them, and a refused key stops the request with a message that says why.

**Architecture:** A new `user_api_keys` table (one row per user and provider) holds AES-256-GCM ciphertext. One resolver, called once per request after `auth()`, turns the four model roles (outline, content, chat, research) into either gateway id strings or direct Anthropic model instances built from the user's key, and the result is passed down explicitly to the drafting, chat, daily-content and research entry points. Every generation-log row records `key_owner`. A guard around each request classifies a provider refusal on a user key into one of four kinds, records it on the key's row, and rethrows a `UserKeyError` that the existing NDJSON error event and server-action error paths carry to the user with a `code`.

**Tech Stack:** Next.js 16 (App Router, server actions, route handlers), Clerk (`auth()`), Drizzle ORM on Neon Postgres with PGlite for tests, Vercel AI SDK 7 (`ai`, `@ai-sdk/anthropic` 4.0.36, moved to `dependencies`), Zod 4, Node `crypto`, Vitest, Tailwind with the repo's `components/ui` primitives.

**Spec:** `docs/superpowers/specs/2026-10-15-user-api-keys-design.md`

## Global Constraints

- Only Anthropic is routed in this version. Keys for other providers are refused at save time with: `That looks like an OpenAI key. Pensieve runs on Claude models, so it can't be used yet. Nothing was saved.` (vendor named from the prefix; `That key isn't one Pensieve recognises. Nothing was saved.` when no prefix matches).
- A refused key stops the request. No fallback to the app's gateway key, automatic or per-user.
- The decrypted key exists only in server memory for one request. It is never logged, never returned to the browser, never part of a `ModelCall`, never written to `generation_log`.
- Encryption: AES-256-GCM, 32-byte secret from `USER_KEY_ENCRYPTION_SECRET` (base64), random 12-byte IV per seal, stored as base64 of `iv || tag || ciphertext`, version 1. A missing or malformed secret is an error at first use, never a fallback to plaintext.
- Identity stays with Clerk; no users table. `user_api_keys.user_id` is the Clerk id as on `tracks`.
- `generation_log.key_owner` is `"app"` or `"user"`, default `"app"`.
- Effort constants (`RESEARCH_LOOP_EFFORT`, `CANDIDATE_STEP_EFFORT`) and the model roles' default ids are unchanged.
- Migration first, deploy second: the new log column must exist before new code inserts into it.
- The repository is public: never commit `.env.local`; `evals/results/` and `.superpowers/` stay ignored.
- TDD throughout: write the failing test, watch it fail, implement, watch it pass, commit. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Verification commands: `npx vitest run`, `npx tsc --noEmit -p .`, `npx eslint <changed files>`.
- Model ids in code are gateway ids (`anthropic/claude-sonnet-5.5`); the Anthropic API ids differ (`claude-sonnet-5-5`) and come only from the map in Task 5.

## Review Focus

Failure modes the spec implies but no section states as a test. Each has its test in the task named.

1. **A key pasted with surrounding whitespace or a trailing newline** must be detected, verified and stored as the trimmed key (Task 4, `detectProvider` and Task 9, the save action trims before everything).
2. **`USER_KEY_ENCRYPTION_SECRET` set to a value that is not 32 bytes** must fail at first use with a message naming the variable, not encrypt with a short key (Task 2).
3. **A key removed while a request is in flight**: the request finishes on the key it started with; the next request resolves afresh with no cache (Task 5, two consecutive `resolveModels` calls see the change).
4. **Anthropic's credit-exhausted body in a different casing or wording order** must still classify as `credits`: match `credit balance` case-insensitively anywhere in the body (Task 7).
5. **A failure on a gateway call must never be recorded on any key row or reclassified**, even when the same user has a key for another provider (Task 7, the guard with no user-keyed model rethrows untouched).

---

## File structure

Created:

- `lib/secrets.ts` — `sealSecret`, `openSecret`, `SECRET_VERSION`. Pure Node crypto.
- `lib/secrets.test.ts`
- `lib/db/userApiKeys.ts` — the five queries over `user_api_keys`.
- `lib/db/userApiKeys.test.ts` — against PGlite via the existing `vi.mock("./client")` pattern.
- `lib/ai/providerKeys.ts` — `detectProvider`, `PROVIDER_NAMES`, `verifyProviderKey`.
- `lib/ai/providerKeys.test.ts`
- `lib/ai/resolve.ts` — `ResolvedModel`, `ModelSet`, `appModel`, `ANTHROPIC_API_IDS`, `DIRECT_PROVIDERS`, `resolveWith`, `resolveModels`.
- `lib/ai/resolve.test.ts`
- `lib/ai/userKeyError.ts` — `UserKeyError`, `classifyProviderError`, `userKeyMessage`, `guardUserKey`, `guardUserKeyCall`.
- `lib/ai/userKeyError.test.ts`
- `app/settings/page.tsx`, `app/settings/actions.ts`, `app/settings/ApiKeyCard.tsx`
- `drizzle/0009_user_api_keys.sql` (+ `drizzle/meta/` entries, generated)

Modified:

- `lib/ai/models.ts` — `MODEL_PROVIDERS`, `providerOf`, `KEY_OWNERS`, `KEY_ERRORS`, `DEFAULT_CHAT_MODEL` moves here.
- `lib/db/schema.ts` — `userApiKeys` table; `keyOwner` on `generationLog`.
- `lib/ai/logged.ts` — `keyOwner` on the row, the row input, the meta and the wrapper options.
- `lib/ai/planDraft.ts`, `lib/ai/planRevision.ts`, `lib/ai/planChat.ts`, `lib/ai/dailyContent.ts`, `lib/ai/research/pipeline.ts` — take a `ResolvedModel` instead of reading a default id.
- `lib/planChat.ts` — `code?` on the three error events.
- `lib/ndjson.ts` — forwards `code`.
- `app/api/plan/draft/route.ts`, `app/api/plan/expand/route.ts`, `app/api/plan/chat/route.ts`, `app/tracks/[id]/actions.ts`, `app/tracks/[id]/nodes/[nodeId]/actions.ts` — resolve models, pass them, guard.
- `components/pensieve/TopNav.tsx` (Settings link), `components/pensieve/PlanWorkspace.tsx` (error link), `components/pensieve/ModelCallsPanel.tsx` (key-owner chip).
- `README.md` (env var), `package.json` (`@ai-sdk/anthropic` to dependencies).

---

### Task 1: Schema, log column and the migration

**Files:**
- Modify: `lib/ai/models.ts`
- Modify: `lib/db/schema.ts`
- Modify: `lib/ai/logged.ts`
- Modify: `lib/ai/planChat.ts:11-12` (the `DEFAULT_CHAT_MODEL` constant moves)
- Create: `drizzle/0009_user_api_keys.sql` (generated)
- Test: `lib/ai/models.test.ts`, `lib/ai/logged.test.ts`

**Interfaces:**
- Produces: in `lib/ai/models.ts`: `MODEL_PROVIDERS`, `type ModelProvider`, `providerOf(id: AiModelId): ModelProvider`, `KEY_OWNERS`, `type KeyOwner = "app" | "user"`, `KEY_ERRORS`, `type KeyErrorKind = "invalid" | "credits" | "rate_limit" | "other"`, `DEFAULT_CHAT_MODEL`. In `lib/db/schema.ts`: `userApiKeys`, `type UserApiKey`, `type NewUserApiKey`; `generationLog.keyOwner`. In `lib/ai/logged.ts`: `GenerationLogRow.keyOwner: KeyOwner`; `BuildGenerationLogRowInput.keyOwner?: KeyOwner`; `GenerationLogMeta.keyOwner?: KeyOwner`; `LoggedGenerateObjectOptions.keyOwner?: KeyOwner`.

- [ ] **Step 1: Write the failing tests**

In `lib/ai/models.test.ts`, extend the import and add a test:

```ts
import { AVAILABLE_MODELS, CANDIDATE_STEP_EFFORT, DEFAULT_CHAT_MODEL, DEFAULT_OUTLINE_MODEL, DEFAULT_CONTENT_MODEL, DEFAULT_RESEARCH_MODEL, MODEL_PROVIDERS, RESEARCH_LOOP_EFFORT, estimateCostUsd, providerOf } from "./models";

  it("knows every listed model's provider, which is the id's prefix", () => {
    for (const model of AVAILABLE_MODELS) expect(MODEL_PROVIDERS).toContain(providerOf(model.id));
    expect(providerOf("anthropic/claude-sonnet-5.5")).toBe("anthropic");
    expect(providerOf("google/gemini-3-flash")).toBe("google");
    expect(providerOf("openai/gpt-5.4-mini")).toBe("openai");
    expect(AVAILABLE_MODELS.map((m) => m.id)).toContain(DEFAULT_CHAT_MODEL);
  });
```

In `lib/ai/logged.test.ts`, add two tests inside `describe("loggedGenerateObject")`:

```ts
  it("records who paid: the app by default, the user when the context or the call says so", async () => {
    mockedGenerateObject.mockResolvedValue(mockResult());
    const rows: GenerationLogRow[] = [];
    await loggedGenerateObject({ model: "anthropic/claude-sonnet-5.5", schema, prompt: "hi" }, { caller: "research", onLog: (row) => void rows.push(row) });
    await loggedGenerateObject({ model: "anthropic/claude-sonnet-5.5", schema, prompt: "hi" }, { caller: "research", keyOwner: "user", onLog: (row) => void rows.push(row) });
    await loggedGenerateObject({ model: "anthropic/claude-sonnet-5.5", schema, prompt: "hi", keyOwner: "user" }, { caller: "daily", onLog: (row) => void rows.push(row) });
    expect(rows.map((r) => r.keyOwner)).toEqual(["app", "user", "user"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/ai/models.test.ts lib/ai/logged.test.ts`
Expected: FAIL. `providerOf` and `MODEL_PROVIDERS` are not exported; `keyOwner` is `undefined`.

- [ ] **Step 3: Add the constants to `lib/ai/models.ts`**

Below `export type AiModelId`:

```ts
/** The providers the model list knows, as the prefix of each model id ("anthropic/claude-sonnet-5.5"). */
export const MODEL_PROVIDERS = ["anthropic", "google", "openai"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** The provider a gateway model id belongs to: the part before the slash. */
export function providerOf(id: AiModelId): ModelProvider {
  return id.split("/")[0] as ModelProvider;
}

/** Who paid for a model call: the app's gateway key, or the user's own key. */
export const KEY_OWNERS = ["app", "user"] as const;
export type KeyOwner = (typeof KEY_OWNERS)[number];

/** Why a user's key was refused, as stored on its row and shown on the settings page. */
export const KEY_ERRORS = ["invalid", "credits", "rate_limit", "other"] as const;
export type KeyErrorKind = (typeof KEY_ERRORS)[number];
```

Beside the other defaults:

```ts
/** Chat turns are short and latency-sensitive; the revision tool uses the outline model. */
export const DEFAULT_CHAT_MODEL: AiModelId = "anthropic/claude-haiku-4.5";
```

In `lib/ai/planChat.ts`, delete the local `DEFAULT_CHAT_MODEL` declaration and its comment, and change the models import to `import { DEFAULT_CHAT_MODEL, type AiModelId } from "./models";`. Add `export { DEFAULT_CHAT_MODEL } from "./models";` so any importer of the old location still compiles.

- [ ] **Step 4: Add the table and the column to `lib/db/schema.ts`**

Add to the imports: `import { KEY_ERRORS, KEY_OWNERS, MODEL_PROVIDERS } from "@/lib/ai/models";`

In `generationLog`, after `userId`:

```ts
  /** Who paid: the app's gateway key, or the user's own key (see user_api_keys). */
  keyOwner: text("key_owner", { enum: KEY_OWNERS }).notNull().default("app"),
```

After the `generationLog` table:

```ts
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

With the other type exports:

```ts
export type UserApiKey = typeof userApiKeys.$inferSelect;
export type NewUserApiKey = typeof userApiKeys.$inferInsert;
```

- [ ] **Step 5: Carry `keyOwner` through `lib/ai/logged.ts`**

Import: `import { estimateCostUsd, type AiModelId, type KeyOwner, type ReasoningEffort } from "./models";`

`GenerationLogRow`: add `keyOwner: KeyOwner;` after `effort`.

`GenerationLogMeta`: add
```ts
  /** Who pays for the calls in this request; "app" when omitted. The resolver sets it from the user's keys. */
  keyOwner?: KeyOwner;
```

`LoggedGenerateObjectOptions`: add
```ts
  /** Who pays for this call when it differs from the context (a resolved model carries its own). */
  keyOwner?: KeyOwner;
```

`BuildGenerationLogRowInput`: add `keyOwner?: KeyOwner;`. In `buildGenerationLogRow`, after `effort`: `keyOwner: input.keyOwner ?? "app",`.

In `loggedGenerateObject`, the `buildGenerationLogRow` call gains `keyOwner: opts.keyOwner ?? meta.keyOwner,`.

- [ ] **Step 6: Generate the migration**

Run: `npx drizzle-kit generate --name user_api_keys`

If it completes, `drizzle/0009_user_api_keys.sql` must read, give or take ordering:

```sql
CREATE TABLE "user_api_keys" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"ciphertext" text NOT NULL,
	"last4" text NOT NULL,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"last_error_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_api_keys_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "generation_log" ADD COLUMN "key_owner" text DEFAULT 'app' NOT NULL;
```

If drizzle-kit stops for lack of a terminal (it has before in this repo), stop and ask the operator to run the same command in their terminal, then continue. Do not hand-write the SQL: the next `generate` diffs against `drizzle/meta/` snapshots and would re-create the table.

- [ ] **Step 7: Run the tests to verify they pass, and that the migration applies**

Run: `npx vitest run lib/ai/models.test.ts lib/ai/logged.test.ts lib/db/materials.test.ts`
Expected: PASS. The materials test migrates a PGlite database from the `drizzle/` folder, so it proves the new migration applies.

Run: `npx tsc --noEmit -p .`
Expected: clean. (`insertGenerationLog` takes the row's new field through `NewGenerationLog`.)

- [ ] **Step 8: Commit**

```bash
git add lib/ai/models.ts lib/ai/models.test.ts lib/db/schema.ts lib/ai/logged.ts lib/ai/logged.test.ts lib/ai/planChat.ts drizzle/
git commit -m "feat(db): user_api_keys table and key_owner on generation_log

Providers, key owners and key error kinds live in lib/ai/models.ts; the
log row, its builder and the generateObject wrapper carry keyOwner, app
by default. DEFAULT_CHAT_MODEL moves to models.ts beside the others.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Encryption at rest

**Files:**
- Create: `lib/secrets.ts`
- Test: `lib/secrets.test.ts`

**Interfaces:**
- Produces: `SECRET_VERSION = 1`; `sealSecret(plaintext: string, env?: NodeJS.ProcessEnv): { ciphertext: string; version: number }`; `openSecret(ciphertext: string, version: number, env?: NodeJS.ProcessEnv): string`. Both read `USER_KEY_ENCRYPTION_SECRET` from `env` (default `process.env`).

- [ ] **Step 1: Write the failing tests**

`lib/secrets.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SECRET_VERSION, openSecret, sealSecret } from "./secrets";

const env = { USER_KEY_ENCRYPTION_SECRET: randomBytes(32).toString("base64") };
const other = { USER_KEY_ENCRYPTION_SECRET: randomBytes(32).toString("base64") };

describe("sealSecret / openSecret", () => {
  it("round-trips, with a fresh IV each time", () => {
    const a = sealSecret("sk-ant-api03-abc", env);
    const b = sealSecret("sk-ant-api03-abc", env);
    expect(a.version).toBe(SECRET_VERSION);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(openSecret(a.ciphertext, a.version, env)).toBe("sk-ant-api03-abc");
    expect(openSecret(b.ciphertext, b.version, env)).toBe("sk-ant-api03-abc");
  });

  it("refuses tampered data, the wrong secret and an unknown version", () => {
    const { ciphertext, version } = sealSecret("sk-ant-api03-abc", env);
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[bytes.length - 1] ^= 0x01;
    expect(() => openSecret(bytes.toString("base64"), version, env)).toThrow(/wrong secret or tampered/);
    expect(() => openSecret(ciphertext, version, other)).toThrow(/wrong secret or tampered/);
    expect(() => openSecret(ciphertext, 2, env)).toThrow(/version/);
  });

  it("fails loudly when the secret is missing or not 32 bytes", () => {
    expect(() => sealSecret("x", {})).toThrow(/USER_KEY_ENCRYPTION_SECRET is not set/);
    expect(() => sealSecret("x", { USER_KEY_ENCRYPTION_SECRET: Buffer.from("short").toString("base64") })).toThrow(/32 bytes/);
    expect(() => openSecret("AAAA", 1, {})).toThrow(/USER_KEY_ENCRYPTION_SECRET is not set/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/secrets.test.ts`
Expected: FAIL, module `./secrets` not found.

- [ ] **Step 3: Write `lib/secrets.ts`**

```ts
/**
 * Encryption at rest for secrets the app holds on a user's behalf (their API keys). AES-256-GCM with a server secret
 * from the environment; a fresh IV per seal; the version says which secret sealed a row so the secret can rotate.
 * The plaintext is never logged by anything here.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SECRET_VERSION = 1;
const ENV_NAME = "USER_KEY_ENCRYPTION_SECRET";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyFromEnv(env: NodeJS.ProcessEnv): Buffer {
  const raw = env[ENV_NAME];
  if (!raw) throw new Error(`${ENV_NAME} is not set; generate one with: openssl rand -base64 32`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${ENV_NAME} must be 32 bytes, base64-encoded (got ${key.length} bytes)`);
  return key;
}

export function sealSecret(plaintext: string, env: NodeJS.ProcessEnv = process.env): { ciphertext: string; version: number } {
  const key = keyFromEnv(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([iv, tag, body]).toString("base64"), version: SECRET_VERSION };
}

export function openSecret(ciphertext: string, version: number, env: NodeJS.ProcessEnv = process.env): string {
  if (version !== SECRET_VERSION) throw new Error(`Unknown secret version ${version}`);
  const key = keyFromEnv(env);
  const bytes = Buffer.from(ciphertext, "base64");
  if (bytes.length <= IV_BYTES + TAG_BYTES) throw new Error("Ciphertext could not be opened: wrong secret or tampered data");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
  decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Ciphertext could not be opened: wrong secret or tampered data");
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/secrets.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/secrets.ts lib/secrets.test.ts
git commit -m "feat: sealSecret/openSecret, AES-256-GCM at rest for users' keys

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Queries over `user_api_keys`

**Files:**
- Create: `lib/db/userApiKeys.ts`
- Test: `lib/db/userApiKeys.test.ts`

**Interfaces:**
- Consumes: `userApiKeys`, `UserApiKey` from `lib/db/schema.ts`; `KeyErrorKind`, `ModelProvider` from `lib/ai/models.ts`.
- Produces: `getUserApiKeys(userId: string): Promise<UserApiKey[]>`; `upsertUserApiKey(input: { userId: string; provider: ModelProvider; ciphertext: string; last4: string; secretVersion: number }): Promise<void>`; `deleteUserApiKey(userId: string, provider: ModelProvider): Promise<void>`; `recordUserApiKeyError(userId: string, provider: ModelProvider, kind: KeyErrorKind, at?: Date): Promise<void>`; `clearUserApiKeyError(userId: string, provider: ModelProvider): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`lib/db/userApiKeys.test.ts`, in the repo's PGlite pattern:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => {
  const { createTestDb } = await import("./testDb");
  const { db } = await createTestDb();
  return { db };
});

import { clearUserApiKeyError, deleteUserApiKey, getUserApiKeys, recordUserApiKeyError, upsertUserApiKey } from "./userApiKeys";

describe("user_api_keys queries", () => {
  it("stores one row per user and provider, replacing on save and clearing any error", async () => {
    await upsertUserApiKey({ userId: "u1", provider: "anthropic", ciphertext: "c1", last4: "k9Qa", secretVersion: 1 });
    await recordUserApiKeyError("u1", "anthropic", "credits", new Date("2026-10-15T10:00:00Z"));
    let rows = await getUserApiKeys("u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "anthropic", ciphertext: "c1", last4: "k9Qa", secretVersion: 1, lastError: "credits" });
    expect(rows[0].lastErrorAt?.toISOString()).toBe("2026-10-15T10:00:00.000Z");

    await upsertUserApiKey({ userId: "u1", provider: "anthropic", ciphertext: "c2", last4: "zz99", secretVersion: 1 });
    rows = await getUserApiKeys("u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ciphertext: "c2", last4: "zz99", lastError: null, lastErrorAt: null });
    expect(await getUserApiKeys("someone-else")).toEqual([]);
  });

  it("clears an error and deletes a key", async () => {
    await upsertUserApiKey({ userId: "u2", provider: "anthropic", ciphertext: "c", last4: "abcd", secretVersion: 1 });
    await recordUserApiKeyError("u2", "anthropic", "invalid");
    await clearUserApiKeyError("u2", "anthropic");
    expect((await getUserApiKeys("u2"))[0]).toMatchObject({ lastError: null, lastErrorAt: null });
    await deleteUserApiKey("u2", "anthropic");
    expect(await getUserApiKeys("u2")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/db/userApiKeys.test.ts`
Expected: FAIL, module `./userApiKeys` not found.

- [ ] **Step 3: Write `lib/db/userApiKeys.ts`**

```ts
import { and, eq } from "drizzle-orm";
import type { KeyErrorKind, ModelProvider } from "@/lib/ai/models";
import { db } from "./client";
import { userApiKeys, type UserApiKey } from "./schema";

/** Every key a user has stored; the resolver's one read per request. Ciphertext only: open it with lib/secrets. */
export async function getUserApiKeys(userId: string): Promise<UserApiKey[]> {
  return db.select().from(userApiKeys).where(eq(userApiKeys.userId, userId));
}

/** Saves or replaces a user's key for a provider. A new key starts with a clean record. */
export async function upsertUserApiKey(input: { userId: string; provider: ModelProvider; ciphertext: string; last4: string; secretVersion: number }): Promise<void> {
  const fresh = { ciphertext: input.ciphertext, last4: input.last4, secretVersion: input.secretVersion, lastError: null, lastErrorAt: null, updatedAt: new Date() };
  await db
    .insert(userApiKeys)
    .values({ userId: input.userId, provider: input.provider, ...fresh })
    .onConflictDoUpdate({ target: [userApiKeys.userId, userApiKeys.provider], set: fresh });
}

export async function deleteUserApiKey(userId: string, provider: ModelProvider): Promise<void> {
  await db.delete(userApiKeys).where(and(eq(userApiKeys.userId, userId), eq(userApiKeys.provider, provider)));
}

/** A request on this key was refused: remember why and when, for the settings page. */
export async function recordUserApiKeyError(userId: string, provider: ModelProvider, kind: KeyErrorKind, at: Date = new Date()): Promise<void> {
  await db
    .update(userApiKeys)
    .set({ lastError: kind, lastErrorAt: at, updatedAt: at })
    .where(and(eq(userApiKeys.userId, userId), eq(userApiKeys.provider, provider)));
}

/** A request on this key succeeded after a refusal: the record is stale. */
export async function clearUserApiKeyError(userId: string, provider: ModelProvider): Promise<void> {
  await db
    .update(userApiKeys)
    .set({ lastError: null, lastErrorAt: null, updatedAt: new Date() })
    .where(and(eq(userApiKeys.userId, userId), eq(userApiKeys.provider, provider)));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/db/userApiKeys.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/db/userApiKeys.ts lib/db/userApiKeys.test.ts
git commit -m "feat(db): queries over user_api_keys

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Provider detection and key verification

**Files:**
- Create: `lib/ai/providerKeys.ts`
- Test: `lib/ai/providerKeys.test.ts`

**Interfaces:**
- Consumes: `ModelProvider` from `lib/ai/models.ts`.
- Produces: `detectProvider(key: string): ModelProvider | null` (trims first); `PROVIDER_NAMES: Record<ModelProvider, string>`; `type KeyCheck = { ok: true } | { ok: false; reason: "invalid" | "unreachable" }`; `verifyProviderKey(provider: ModelProvider, key: string, fetchImpl?: typeof fetch): Promise<KeyCheck>`.

- [ ] **Step 1: Write the failing tests**

`lib/ai/providerKeys.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_NAMES, detectProvider, verifyProviderKey } from "./providerKeys";

describe("detectProvider", () => {
  it("reads the vendor from the key's prefix, Anthropic before OpenAI, and trims first", () => {
    expect(detectProvider("sk-ant-api03-abc")).toBe("anthropic");
    expect(detectProvider("  sk-ant-api03-abc\n")).toBe("anthropic");
    expect(detectProvider("sk-proj-abc")).toBe("openai");
    expect(detectProvider("sk-abc")).toBe("openai");
    expect(detectProvider("AIzaSyAbc")).toBe("google");
    expect(detectProvider("hello")).toBeNull();
    expect(detectProvider("")).toBeNull();
    expect(PROVIDER_NAMES.anthropic).toBe("Anthropic");
  });
});

describe("verifyProviderKey", () => {
  const withStatus = (status: number) => vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

  it("calls Anthropic's models endpoint with the key and reads the status", async () => {
    const fetchImpl = withStatus(200);
    expect(await verifyProviderKey("anthropic", "sk-ant-x", fetchImpl)).toEqual({ ok: true });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-x");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    expect(await verifyProviderKey("anthropic", "sk-ant-x", withStatus(401))).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyProviderKey("anthropic", "sk-ant-x", withStatus(403))).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyProviderKey("anthropic", "sk-ant-x", withStatus(503))).toEqual({ ok: false, reason: "unreachable" });
  });

  it("treats a network failure as unreachable and an unrouted provider as invalid", async () => {
    const failing = vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect(await verifyProviderKey("anthropic", "sk-ant-x", failing)).toEqual({ ok: false, reason: "unreachable" });
    expect(await verifyProviderKey("openai", "sk-x", withStatus(200))).toEqual({ ok: false, reason: "invalid" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/ai/providerKeys.test.ts`
Expected: FAIL, module `./providerKeys` not found.

- [ ] **Step 3: Write `lib/ai/providerKeys.ts`**

```ts
import type { ModelProvider } from "./models";

export const PROVIDER_NAMES: Record<ModelProvider, string> = { anthropic: "Anthropic", google: "Google", openai: "OpenAI" };

/** The vendor a key belongs to, from its prefix. Anthropic's "sk-ant-" is checked before OpenAI's "sk-". */
export function detectProvider(key: string): ModelProvider | null {
  const k = key.trim();
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("AIza")) return "google";
  if (k.startsWith("sk-")) return "openai";
  return null;
}

export type KeyCheck = { ok: true } | { ok: false; reason: "invalid" | "unreachable" };

/**
 * Proves a key is accepted by its provider with a call that costs nothing. Anthropic's models endpoint answers 200 for a
 * live key and 401 for a dead one. This proves the key, not the balance. Providers without a route are not checked.
 */
export async function verifyProviderKey(provider: ModelProvider, key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  if (provider !== "anthropic") return { ok: false, reason: "invalid" };
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid" };
    return { ok: false, reason: "unreachable" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/ai/providerKeys.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ai/providerKeys.ts lib/ai/providerKeys.test.ts
git commit -m "feat(ai): detect a key's provider from its prefix and verify it with the provider

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The resolver and the Anthropic registry

**Files:**
- Create: `lib/ai/resolve.ts`
- Test: `lib/ai/resolve.test.ts`
- Modify: `package.json` (move `@ai-sdk/anthropic` to `dependencies`)

**Interfaces:**
- Consumes: `openSecret` (Task 2); `getUserApiKeys` (Task 3); `AVAILABLE_MODELS`, `DEFAULT_*_MODEL`, `providerOf`, `AiModelId`, `KeyOwner`, `ModelProvider` (Task 1); `createAnthropic` from `@ai-sdk/anthropic`; `LanguageModel` from `ai`.
- Produces:
  ```ts
  export interface ResolvedModel { model: AiModelId | LanguageModel; id: AiModelId; keyOwner: KeyOwner }
  export interface ModelSet { outline: ResolvedModel; content: ResolvedModel; chat: ResolvedModel; research: ResolvedModel }
  export type ModelRole = keyof ModelSet;
  export const DEFAULT_MODEL_IDS: Record<ModelRole, AiModelId>;
  export function appModel(id: AiModelId): ResolvedModel;
  export const ANTHROPIC_API_IDS: Partial<Record<AiModelId, string>>;
  export interface DirectProvider { apiIds: Partial<Record<AiModelId, string>>; create(apiKey: string): (apiId: string) => LanguageModel }
  export const DIRECT_PROVIDERS: Partial<Record<ModelProvider, DirectProvider>>;
  export function resolveWith(keys: Partial<Record<ModelProvider, string>>, defaults?: Record<ModelRole, AiModelId>, registry?: Partial<Record<ModelProvider, DirectProvider>>): ModelSet;
  export interface ResolvedModels extends ModelSet { keyErrors: Partial<Record<ModelProvider, boolean>> }
  export async function resolveModels(userId: string): Promise<ResolvedModels>;
  ```

- [ ] **Step 1: Move the Anthropic provider to runtime dependencies**

Run: `npm install @ai-sdk/anthropic@4.0.36 --save-prod`
Expected: `package.json` lists `"@ai-sdk/anthropic": "4.0.36"` under `dependencies` and no longer under `devDependencies`; `package-lock.json` updated.

- [ ] **Step 2: Write the failing tests**

`lib/ai/resolve.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { sealSecret } from "@/lib/secrets";
import { AVAILABLE_MODELS, providerOf } from "./models";

vi.mock("@/lib/db/userApiKeys", () => ({ getUserApiKeys: vi.fn() }));

import { getUserApiKeys } from "@/lib/db/userApiKeys";
import { ANTHROPIC_API_IDS, DEFAULT_MODEL_IDS, appModel, resolveModels, resolveWith } from "./resolve";

const mockedKeys = vi.mocked(getUserApiKeys);
const SECRET = randomBytes(32).toString("base64");

function instance(m: unknown): { modelId: string; provider: string } {
  if (typeof m === "string") throw new Error("expected a model instance, got a gateway id");
  return m as { modelId: string; provider: string };
}

describe("resolveWith", () => {
  it("returns the gateway ids, paid by the app, when the user has no key", () => {
    const set = resolveWith({});
    expect(set.outline).toEqual(appModel(DEFAULT_MODEL_IDS.outline));
    expect(set.research).toEqual({ model: DEFAULT_MODEL_IDS.research, id: DEFAULT_MODEL_IDS.research, keyOwner: "app" });
  });

  it("builds direct Anthropic instances, paid by the user, for every role when they hold an Anthropic key", () => {
    const set = resolveWith({ anthropic: "sk-ant-test" });
    for (const role of ["outline", "content", "chat", "research"] as const) {
      expect(set[role].keyOwner).toBe("user");
      expect(set[role].id).toBe(DEFAULT_MODEL_IDS[role]);
      expect(instance(set[role].model).modelId).toBe(ANTHROPIC_API_IDS[DEFAULT_MODEL_IDS[role]]);
      expect(instance(set[role].model).provider).toContain("anthropic");
    }
  });

  it("ignores a key for a provider without a direct route", () => {
    const set = resolveWith({ google: "AIza-test", openai: "sk-test" });
    expect(set.research).toEqual(appModel(DEFAULT_MODEL_IDS.research));
  });

  it("maps every Anthropic model in the list to an API id", () => {
    for (const m of AVAILABLE_MODELS) if (providerOf(m.id) === "anthropic") expect(ANTHROPIC_API_IDS[m.id], m.id).toMatch(/^claude-/);
    expect(ANTHROPIC_API_IDS["anthropic/claude-sonnet-5.5"]).toBe("claude-sonnet-5-5");
  });
});

describe("resolveModels", () => {
  beforeEach(() => {
    mockedKeys.mockReset();
    process.env.USER_KEY_ENCRYPTION_SECRET = SECRET;
  });

  it("reads the user's rows afresh on every call, decrypts in memory and reports recorded errors", async () => {
    const sealed = sealSecret("sk-ant-live", { USER_KEY_ENCRYPTION_SECRET: SECRET });
    mockedKeys.mockResolvedValueOnce([
      { userId: "u1", provider: "anthropic", ciphertext: sealed.ciphertext, last4: "live", secretVersion: sealed.version, lastError: "credits", lastErrorAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
    ]);
    const first = await resolveModels("u1");
    expect(first.research.keyOwner).toBe("user");
    expect(instance(first.research.model).modelId).toBe("claude-sonnet-5-5");
    expect(first.keyErrors).toEqual({ anthropic: true });

    mockedKeys.mockResolvedValueOnce([]); // the key was removed between requests
    const second = await resolveModels("u1");
    expect(second.research.keyOwner).toBe("app");
    expect(second.keyErrors).toEqual({});
    expect(mockedKeys).toHaveBeenCalledTimes(2);
    const _typeCheck: LanguageModel | string = second.research.model;
    void _typeCheck;
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run lib/ai/resolve.test.ts`
Expected: FAIL, module `./resolve` not found.

- [ ] **Step 4: Write `lib/ai/resolve.ts`**

```ts
/**
 * Which model object each role uses for one request: the gateway id string paid by the app, or a direct instance built
 * from the user's own key and paid by them. Resolved once per request, right after auth(), and passed down explicitly.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { getUserApiKeys } from "@/lib/db/userApiKeys";
import { openSecret } from "@/lib/secrets";
import { DEFAULT_CHAT_MODEL, DEFAULT_CONTENT_MODEL, DEFAULT_OUTLINE_MODEL, DEFAULT_RESEARCH_MODEL, providerOf, type AiModelId, type KeyOwner, type ModelProvider } from "./models";

export interface ResolvedModel {
  /** The gateway id string, or a direct instance built from the user's key. */
  model: AiModelId | LanguageModel;
  /** Always the gateway-style id, for logging and pricing. */
  id: AiModelId;
  keyOwner: KeyOwner;
}

export interface ModelSet {
  outline: ResolvedModel;
  content: ResolvedModel;
  chat: ResolvedModel;
  research: ResolvedModel;
}
export type ModelRole = keyof ModelSet;

export const DEFAULT_MODEL_IDS: Record<ModelRole, AiModelId> = {
  outline: DEFAULT_OUTLINE_MODEL,
  content: DEFAULT_CONTENT_MODEL,
  chat: DEFAULT_CHAT_MODEL,
  research: DEFAULT_RESEARCH_MODEL,
};

/** The app's own route for a model: the gateway id, paid by the app. */
export function appModel(id: AiModelId): ResolvedModel {
  return { model: id, id, keyOwner: "app" };
}

/** Gateway ids use dots; Anthropic's API uses hyphens. Only ids listed here can run on a user's key. */
export const ANTHROPIC_API_IDS: Partial<Record<AiModelId, string>> = {
  "anthropic/claude-haiku-4.5": "claude-haiku-4-5",
  "anthropic/claude-sonnet-5": "claude-sonnet-5",
  "anthropic/claude-sonnet-5.5": "claude-sonnet-5-5",
  "anthropic/claude-opus-5": "claude-opus-5",
  "anthropic/claude-opus-5.5": "claude-opus-5-5",
};

export interface DirectProvider {
  apiIds: Partial<Record<AiModelId, string>>;
  create(apiKey: string): (apiId: string) => LanguageModel;
}

/** Providers the app can call directly with a user's key. Adding one is a package, an entry here, and an eval pass. */
export const DIRECT_PROVIDERS: Partial<Record<ModelProvider, DirectProvider>> = {
  anthropic: {
    apiIds: ANTHROPIC_API_IDS,
    create: (apiKey) => {
      const provider = createAnthropic({ apiKey });
      return (apiId) => provider(apiId);
    },
  },
};

/** Pure: the user's decrypted keys by provider decide each role, against the defaults and the registry. */
export function resolveWith(
  keys: Partial<Record<ModelProvider, string>>,
  defaults: Record<ModelRole, AiModelId> = DEFAULT_MODEL_IDS,
  registry: Partial<Record<ModelProvider, DirectProvider>> = DIRECT_PROVIDERS,
): ModelSet {
  const resolve = (id: AiModelId): ResolvedModel => {
    const provider = providerOf(id);
    const key = keys[provider];
    const direct = registry[provider];
    const apiId = direct?.apiIds[id];
    if (!key || !direct || !apiId) return appModel(id);
    return { model: direct.create(key)(apiId), id, keyOwner: "user" };
  };
  return { outline: resolve(defaults.outline), content: resolve(defaults.content), chat: resolve(defaults.chat), research: resolve(defaults.research) };
}

export interface ResolvedModels extends ModelSet {
  /** Providers whose stored key has a refusal on record, so a success can clear it with one conditional write. */
  keyErrors: Partial<Record<ModelProvider, boolean>>;
}

/** One query, decrypt in memory, resolve. No cache: a removed key stops being used on the next request. */
export async function resolveModels(userId: string): Promise<ResolvedModels> {
  const rows = await getUserApiKeys(userId);
  const keys: Partial<Record<ModelProvider, string>> = {};
  const keyErrors: Partial<Record<ModelProvider, boolean>> = {};
  for (const row of rows) {
    keys[row.provider] = openSecret(row.ciphertext, row.secretVersion);
    if (row.lastError) keyErrors[row.provider] = true;
  }
  return { ...resolveWith(keys), keyErrors };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/ai/resolve.test.ts`
Expected: PASS (5 tests). If `provider` on the instance is not a string containing `anthropic`, read the instance's actual `provider` value in the failure output and adjust the assertion to that exact string; the SDK's Anthropic models report `anthropic.messages`.

- [ ] **Step 6: Commit**

```bash
git add lib/ai/resolve.ts lib/ai/resolve.test.ts package.json package-lock.json
git commit -m "feat(ai): resolve each model role to the gateway or the user's own Anthropic key

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Drafting, expansion and revision take a resolved outline model

**Files:**
- Modify: `lib/ai/planDraft.ts` (`StreamUnitsInput`, `streamUnits`, `DraftLevelInput.ctx`, `draftLevel`, `StreamPlanDraftInput`, `streamPlanDraft`, `StreamExpandNodeInput`, `streamExpandNode`, `StreamResearchedDraftInput`, `streamResearchedPlanDraft`)
- Modify: `lib/ai/planRevision.ts` (`RevisePlanInput`, `revisePlanTree`)
- Test: `lib/ai/planDraft.test.ts`

**Interfaces:**
- Consumes: `ResolvedModel`, `appModel` (Task 5); `DEFAULT_OUTLINE_MODEL` (models.ts).
- Produces: `StreamPlanDraftInput.outlineModel?: ResolvedModel`; `StreamExpandNodeInput.outlineModel?: ResolvedModel`; `StreamResearchedDraftInput` inherits `outlineModel?`; `RevisePlanInput.outlineModel?: ResolvedModel`. Omitted means `appModel(DEFAULT_OUTLINE_MODEL)`, so the eval scripts and existing tests are unchanged.

- [ ] **Step 1: Write the failing test**

In `lib/ai/planDraft.test.ts`, add inside the existing `describe` that uses `mockedStreamObject` (the `fakeStream` helper is already there):

```ts
  it("drafts on the outline model it is given and records who paid", async () => {
    mockedStreamObject.mockImplementation(() => fakeStream([{ title: "Week 1", summary: "s", spanDays: 7, covers: [], materials: [] }] as UnitDraft[]));
    const direct = { modelId: "claude-haiku-4-5", provider: "anthropic.messages" };
    const calls: ModelCall[] = [];
    const events: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({
      topic: "T", days: 7, granularity: "week", materials: [], hoursPerWeek: 6,
      outlineModel: { model: direct as never, id: "anthropic/claude-haiku-4.5", keyOwner: "user" },
      log: { onCall: (c) => void calls.push(c) },
    })) events.push(event);
    expect(mockedStreamObject.mock.calls[0][0].model).toBe(direct);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.model).toBe("anthropic/claude-haiku-4.5");
      expect(c.keyOwner).toBe("user");
    }
  });
```

If `UnitDraft` requires fields this literal lacks, copy a unit literal from an existing test in the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/ai/planDraft.test.ts`
Expected: FAIL: `outlineModel` is not an accepted property (type error at compile or `keyOwner` is `"app"` at runtime).

- [ ] **Step 3: Thread the model through `lib/ai/planDraft.ts`**

Imports: replace `import { DEFAULT_OUTLINE_MODEL } from "./models";` with
```ts
import { DEFAULT_OUTLINE_MODEL } from "./models";
import { appModel, type ResolvedModel } from "./resolve";
```

`StreamUnitsInput`: add `model: ResolvedModel;`.

`streamUnits`: `streamObject({ model: input.model.model, ... })`; the `buildGenerationLogRow` call becomes `model: input.model.id, keyOwner: input.model.keyOwner,` in place of `model: DEFAULT_OUTLINE_MODEL`.

`DraftLevelInput.ctx`: add `outlineModel: ResolvedModel;` to the inline type. In `draftLevel`, every `streamUnits({...})` call gains `model: ctx.outlineModel`.

`StreamPlanDraftInput`: add
```ts
  /** The model that drafts units; the app's outline model when omitted (eval, tests). */
  outlineModel?: ResolvedModel;
```
In `streamPlanDraft`, every `draftLevel({ ctx: input, ... })` call passes `ctx: { ...input, outlineModel: input.outlineModel ?? appModel(DEFAULT_OUTLINE_MODEL) }` instead. There are three, matching the function's doc comment: the top level, the first unit's children, and the first grandchild's children. Define `const outlineModel = input.outlineModel ?? appModel(DEFAULT_OUTLINE_MODEL);` once at the top of the function and reuse it.

`StreamExpandNodeInput`: add the same `outlineModel?: ResolvedModel;` and give `streamExpandNode`'s `draftLevel` call the same `ctx` spread.

`streamResearchedPlanDraft` already spreads `...input` into `streamPlanDraft`, so `outlineModel` flows through unchanged.

- [ ] **Step 4: Thread the model through `lib/ai/planRevision.ts`**

Imports: add `import { appModel, type ResolvedModel } from "./resolve";` (keep `DEFAULT_OUTLINE_MODEL`).

`RevisePlanInput`: add `outlineModel?: ResolvedModel;`.

In `revisePlanTree`, `const model = input.outlineModel ?? appModel(DEFAULT_OUTLINE_MODEL);` and the `loggedGenerateObject` options become `model: model.id, languageModel: typeof model.model === "string" ? undefined : model.model, keyOwner: model.keyOwner,` in place of `model: DEFAULT_OUTLINE_MODEL`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/ai/planDraft.test.ts lib/ai/planRevision.test.ts && npx tsc --noEmit -p .`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add lib/ai/planDraft.ts lib/ai/planDraft.test.ts lib/ai/planRevision.ts
git commit -m "feat(ai): drafting, expansion and revision take a resolved outline model

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Chat, daily content and the research arm take resolved models

**Files:**
- Modify: `lib/ai/planChat.ts` (`RunPlanChatOptions`, `runPlanChat`)
- Modify: `lib/ai/dailyContent.ts` (`GenerateDailyContentInput`, `generateDailyContent`)
- Modify: `lib/ai/research/pipeline.ts` (`defaultArm`)
- Test: `lib/ai/dailyContent.test.ts`, `lib/ai/research/workers.test.ts`

**Interfaces:**
- Consumes: `ResolvedModel`, `appModel` (Task 5).
- Produces: `RunPlanChatOptions = { log?: GenerationLogContext; model?: ResolvedModel; outlineModel?: ResolvedModel }`; `GenerateDailyContentInput.model?: ResolvedModel`; `defaultArm(env?: Record<string, string | undefined>, options?: { model?: AiModelId | LanguageModel }): ResearchArm | null`.

- [ ] **Step 1: Write the failing tests**

In `lib/ai/dailyContent.test.ts`, add at the top of the file (the file today tests pure functions only; the mock must precede the import of `./dailyContent`):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
import { generateObject } from "ai";
const mockedGenerateObject = vi.mocked(generateObject);
```

and a test (adapt the `input` fields to `GenerateDailyContentInput` as the file's other tests build it):

```ts
describe("generateDailyContent", () => {
  beforeEach(() => mockedGenerateObject.mockReset());

  it("generates on the content model it is given and records who paid", async () => {
    mockedGenerateObject.mockResolvedValue({
      object: { contentMarkdown: "Read ch. 1.", citations: [] },
      usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 },
      finishReason: "stop",
    } as unknown as Awaited<ReturnType<typeof generateObject>>);
    const direct = { modelId: "claude-sonnet-5", provider: "anthropic.messages" };
    const calls: import("./logged").ModelCall[] = [];
    await generateDailyContent({
      title: "Day 1", summary: "s", unit: "day", spanDays: 1, materials: [],
      model: { model: direct as never, id: "anthropic/claude-sonnet-5", keyOwner: "user" },
      log: { onCall: (c) => void calls.push(c) },
    });
    expect(mockedGenerateObject.mock.calls[0][0].model).toBe(direct);
    expect(calls[0]).toMatchObject({ model: "anthropic/claude-sonnet-5", keyOwner: "user" });
  });
});
```

In `lib/ai/research/workers.test.ts`, in the `defaultArm` test, add:

```ts
    const arm = defaultArm({ TAVILY_API_KEY: "k", RESEARCH_ARM: "workers" }, { model: "anthropic/claude-opus-5.5" });
    expect(arm?.name).toBe("researchWorkers");
```

(This pins the two-argument signature; the model's effect is covered by the arms' own `model` option tests.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/ai/dailyContent.test.ts lib/ai/research/workers.test.ts`
Expected: FAIL: `model` is not a property of the daily-content input; `defaultArm` takes one argument.

- [ ] **Step 3: Change `lib/ai/dailyContent.ts`**

Imports: `import { DEFAULT_CONTENT_MODEL } from "./models"; import { appModel, type ResolvedModel } from "./resolve";`

`GenerateDailyContentInput`: add
```ts
  /** The model that writes the content; the app's content model when omitted. */
  model?: ResolvedModel;
```

In `generateDailyContent`: `const model = input.model ?? appModel(DEFAULT_CONTENT_MODEL);` and the `loggedGenerateObject` options become `model: model.id, languageModel: typeof model.model === "string" ? undefined : model.model, keyOwner: model.keyOwner,`.

- [ ] **Step 4: Change `lib/ai/planChat.ts`**

`RunPlanChatOptions`:
```ts
export interface RunPlanChatOptions {
  log?: GenerationLogContext;
  /** The model that answers; the app's chat model when omitted. */
  model?: ResolvedModel;
  /** The model the revision tool drafts with; the app's outline model when omitted. */
  outlineModel?: ResolvedModel;
}
```
Import `appModel, type ResolvedModel` from `./resolve`.

In `runPlanChat`: `const chat = options.model ?? appModel(DEFAULT_CHAT_MODEL);`. The `revisePlanTree({...})` call inside the tool gains `outlineModel: options.outlineModel,`. `streamText({ model: chat.model, ... })`. The `buildGenerationLogRow` call becomes `model: chat.id, keyOwner: chat.keyOwner,` in place of `model`.

- [ ] **Step 5: Change `defaultArm` in `lib/ai/research/pipeline.ts`**

```ts
export function defaultArm(
  env: Record<string, string | undefined> = process.env,
  options: { model?: AiModelId | LanguageModel } = {},
): ResearchArm | null {
  const provider = searchProviderFromEnv(env);
  if (!provider) return null;
  const common = { provider, model: options.model };
  return env.RESEARCH_ARM?.trim().toLowerCase() === "workers" ? createWorkersArm(common) : createAgentArm(common);
}
```
Add `type LanguageModel` from `ai` and `type AiModelId` from `../models` to the imports if absent.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run lib/ai/dailyContent.test.ts lib/ai/research/workers.test.ts && npx tsc --noEmit -p .`
Expected: PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add lib/ai/planChat.ts lib/ai/dailyContent.ts lib/ai/dailyContent.test.ts lib/ai/research/pipeline.ts lib/ai/research/workers.test.ts
git commit -m "feat(ai): chat, daily content and the research arm take resolved models

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The failure path

**Files:**
- Create: `lib/ai/userKeyError.ts`
- Test: `lib/ai/userKeyError.test.ts`, `lib/ndjson.test.ts`
- Modify: `lib/ndjson.ts`, `lib/planChat.ts:63-110` (the three error events)

**Interfaces:**
- Consumes: `APICallError` from `ai`; `KeyErrorKind`, `ModelProvider`, `providerOf` (Task 1); `PROVIDER_NAMES` (Task 4); `ResolvedModels` (Task 5); `recordUserApiKeyError`, `clearUserApiKeyError` (Task 3).
- Produces:
  ```ts
  export class UserKeyError extends Error { readonly code: KeyErrorKind; readonly provider: ModelProvider }
  export function classifyProviderError(error: unknown): KeyErrorKind;
  export function userKeyMessage(provider: ModelProvider, kind: KeyErrorKind, status?: number): string;
  export interface UserKeyGuard { userId: string; models: ResolvedModels; record?: typeof recordUserApiKeyError; clear?: typeof clearUserApiKeyError }
  export function guardUserKey<T>(events: AsyncIterable<T>, guard: UserKeyGuard): AsyncGenerator<T>;
  export function guardUserKeyCall<T>(run: () => Promise<T>, guard: UserKeyGuard): Promise<T>;
  ```
  The three stream error events in `lib/planChat.ts` become `{ type: "error"; message: string; code?: KeyErrorKind }`. `ndjsonResponse` adds `code` to the error event when the thrown error has a string `code`.

- [ ] **Step 1: Write the failing tests**

`lib/ai/userKeyError.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import type { ResolvedModels } from "./resolve";
import { UserKeyError, classifyProviderError, guardUserKey, guardUserKeyCall, userKeyMessage } from "./userKeyError";

function apiError(statusCode: number, responseBody: string) {
  return new APICallError({ message: `status ${statusCode}`, url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode, responseBody, isRetryable: false });
}
const userModel = { model: {} as never, id: "anthropic/claude-sonnet-5.5" as const, keyOwner: "user" as const };
const appModelR = { model: "anthropic/claude-sonnet-5.5" as const, id: "anthropic/claude-sonnet-5.5" as const, keyOwner: "app" as const };
const onUserKey: ResolvedModels = { outline: userModel, content: userModel, chat: userModel, research: userModel, keyErrors: {} };
const onApp: ResolvedModels = { outline: appModelR, content: appModelR, chat: appModelR, research: appModelR, keyErrors: {} };

describe("classifyProviderError", () => {
  it("reads the four kinds from the status and body, matching the credits message loosely", () => {
    expect(classifyProviderError(apiError(400, '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'))).toBe("credits");
    expect(classifyProviderError(apiError(400, "CREDIT BALANCE too low"))).toBe("credits");
    expect(classifyProviderError(apiError(401, '{"error":{"type":"authentication_error"}}'))).toBe("invalid");
    expect(classifyProviderError(apiError(403, ""))).toBe("invalid");
    expect(classifyProviderError(apiError(429, ""))).toBe("rate_limit");
    expect(classifyProviderError(apiError(400, "some other validation problem"))).toBe("other");
    expect(classifyProviderError(apiError(529, "overloaded"))).toBe("other");
    expect(classifyProviderError(new Error("not an API error"))).toBe("other");
  });

  it("writes the user's message per kind", () => {
    expect(userKeyMessage("anthropic", "credits")).toBe("Your Anthropic credits are exhausted, so this stopped. Add credits in the Console or remove your key in Settings to use Pensieve's.");
    expect(userKeyMessage("anthropic", "invalid")).toBe("Anthropic rejected your key. Replace it in Settings, or remove it to use Pensieve's.");
    expect(userKeyMessage("anthropic", "rate_limit")).toBe("Anthropic is rate-limiting your key. Try again in a minute.");
    expect(userKeyMessage("anthropic", "other", 529)).toBe("Anthropic returned an error for your key (status 529). Try again; if it keeps happening, check the Console.");
  });
});

describe("guardUserKey", () => {
  async function* failing(): AsyncGenerator<string> {
    yield "a";
    throw apiError(400, "credit balance is too low");
  }
  async function* fine(): AsyncGenerator<string> {
    yield "a";
  }

  it("turns a refusal on a user key into a UserKeyError and records it on the key", async () => {
    const record = vi.fn(async () => {});
    const seen: string[] = [];
    await expect(async () => {
      for await (const e of guardUserKey(failing(), { userId: "u1", models: onUserKey, record })) seen.push(e);
    }).rejects.toMatchObject({ code: "credits", provider: "anthropic", message: expect.stringContaining("credits are exhausted") });
    expect(seen).toEqual(["a"]);
    expect(record).toHaveBeenCalledWith("u1", "anthropic", "credits");
  });

  it("leaves a failure on the app's key untouched and records nothing", async () => {
    const record = vi.fn(async () => {});
    await expect(async () => {
      for await (const _ of guardUserKey(failing(), { userId: "u1", models: onApp, record })) void _;
    }).rejects.toSatisfy((e: unknown) => APICallError.isInstance(e) && !(e instanceof UserKeyError));
    expect(record).not.toHaveBeenCalled();
  });

  it("clears a recorded error once a request completes on the key, and only then", async () => {
    const clear = vi.fn(async () => {});
    for await (const _ of guardUserKey(fine(), { userId: "u1", models: { ...onUserKey, keyErrors: { anthropic: true } }, clear })) void _;
    expect(clear).toHaveBeenCalledWith("u1", "anthropic");
    clear.mockClear();
    for await (const _ of guardUserKey(fine(), { userId: "u1", models: onUserKey, clear })) void _;
    expect(clear).not.toHaveBeenCalled();
  });

  it("guards a plain promise the same way", async () => {
    const record = vi.fn(async () => {});
    await expect(guardUserKeyCall(async () => { throw apiError(401, ""); }, { userId: "u1", models: onUserKey, record })).rejects.toMatchObject({ code: "invalid" });
    expect(record).toHaveBeenCalledWith("u1", "anthropic", "invalid");
    expect(await guardUserKeyCall(async () => 42, { userId: "u1", models: onUserKey, record })).toBe(42);
  });
});
```

In `lib/ndjson.test.ts`, add beside the existing error test:

```ts
  it("forwards an error's code when it has one", async () => {
    async function* gen() {
      yield { type: "a" };
      throw Object.assign(new Error("Your Anthropic credits are exhausted"), { code: "credits" });
    }
    const seen: unknown[] = [];
    await readNdjson(ndjsonResponse(gen()), (e) => seen.push(e));
    expect(seen).toEqual([{ type: "a" }, { type: "error", message: "Your Anthropic credits are exhausted", code: "credits" }]);
  });
```

(Use the same helper the existing error test uses to read the response; `readNdjson` is exported from the module.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/ai/userKeyError.test.ts lib/ndjson.test.ts`
Expected: FAIL: module `./userKeyError` not found; the NDJSON error event has no `code`.

- [ ] **Step 3: Write `lib/ai/userKeyError.ts`**

```ts
/**
 * A refusal on a user's own key, told to the user in their words and recorded on the key's row. Gateway calls are not
 * touched: the guard only acts when a model in the request runs on the user's key.
 */
import { APICallError } from "ai";
import { clearUserApiKeyError, recordUserApiKeyError } from "@/lib/db/userApiKeys";
import { providerOf, type KeyErrorKind, type ModelProvider } from "./models";
import { PROVIDER_NAMES } from "./providerKeys";
import type { ResolvedModels } from "./resolve";

export class UserKeyError extends Error {
  constructor(
    readonly provider: ModelProvider,
    readonly code: KeyErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "UserKeyError";
  }
}

export function classifyProviderError(error: unknown): KeyErrorKind {
  if (!APICallError.isInstance(error)) return "other";
  const status = error.statusCode;
  if (status === 401 || status === 403) return "invalid";
  if (status === 429) return "rate_limit";
  if (status === 400 && (error.responseBody ?? "").toLowerCase().includes("credit balance")) return "credits";
  return "other";
}

export function userKeyMessage(provider: ModelProvider, kind: KeyErrorKind, status?: number): string {
  const name = PROVIDER_NAMES[provider];
  switch (kind) {
    case "credits":
      return `Your ${name} credits are exhausted, so this stopped. Add credits in the Console or remove your key in Settings to use Pensieve's.`;
    case "invalid":
      return `${name} rejected your key. Replace it in Settings, or remove it to use Pensieve's.`;
    case "rate_limit":
      return `${name} is rate-limiting your key. Try again in a minute.`;
    case "other":
      return `${name} returned an error for your key${status ? ` (status ${status})` : ""}. Try again; if it keeps happening, check the Console.`;
  }
}

export interface UserKeyGuard {
  userId: string;
  models: ResolvedModels;
  record?: typeof recordUserApiKeyError;
  clear?: typeof clearUserApiKeyError;
}

/** The providers whose key the request runs on; empty when everything is on the app's gateway key. */
function userProviders(models: ResolvedModels): ModelProvider[] {
  const roles = [models.outline, models.content, models.chat, models.research];
  return [...new Set(roles.filter((m) => m.keyOwner === "user").map((m) => providerOf(m.id)))];
}

function translate(error: unknown, guard: UserKeyGuard): unknown {
  const providers = userProviders(guard.models);
  if (providers.length === 0 || !APICallError.isInstance(error)) return error;
  const provider = providers[0];
  const kind = classifyProviderError(error);
  void (guard.record ?? recordUserApiKeyError)(guard.userId, provider, kind).catch(() => undefined);
  return new UserKeyError(provider, kind, userKeyMessage(provider, kind, error.statusCode));
}

function clearIfRecorded(guard: UserKeyGuard): void {
  for (const provider of userProviders(guard.models)) {
    if (guard.models.keyErrors[provider]) void (guard.clear ?? clearUserApiKeyError)(guard.userId, provider).catch(() => undefined);
  }
}

/** Wraps a request's event stream: a refusal on the user's key becomes a UserKeyError; a completed stream clears a recorded one. */
export async function* guardUserKey<T>(events: AsyncIterable<T>, guard: UserKeyGuard): AsyncGenerator<T> {
  try {
    for await (const event of events) yield event;
  } catch (error) {
    throw translate(error, guard);
  }
  clearIfRecorded(guard);
}

/** The same for a server action's single promise. */
export async function guardUserKeyCall<T>(run: () => Promise<T>, guard: UserKeyGuard): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    throw translate(error, guard);
  }
  clearIfRecorded(guard);
  return result;
}
```

- [ ] **Step 4: Forward `code` in `lib/ndjson.ts` and type it on the events**

In `ndjsonResponse`'s `catch`:
```ts
      } catch (error) {
        const message = error instanceof Error ? error.message : "stream failed";
        const code = error instanceof Error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
        controller.enqueue(encoder.encode(JSON.stringify(code ? { type: "error", message, code } : { type: "error", message }) + "\n"));
      }
```

In `lib/planChat.ts`, add `import type { KeyErrorKind } from "@/lib/ai/models";` and change each of the three `| { type: "error"; message: string }` to `| { type: "error"; message: string; code?: KeyErrorKind }`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/ai/userKeyError.test.ts lib/ndjson.test.ts && npx tsc --noEmit -p .`
Expected: PASS, tsc clean. If `APICallError`'s constructor rejects a field in the test helper, drop that field; `message`, `url`, `requestBodyValues`, `statusCode`, `responseBody` are the ones the classifier reads.

- [ ] **Step 6: Commit**

```bash
git add lib/ai/userKeyError.ts lib/ai/userKeyError.test.ts lib/ndjson.ts lib/ndjson.test.ts lib/planChat.ts
git commit -m "feat(ai): a refusal on a user's key becomes a UserKeyError with a code and a message

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Wire the routes and server actions

**Files:**
- Modify: `app/api/plan/draft/route.ts`, `app/api/plan/expand/route.ts`, `app/api/plan/chat/route.ts`
- Modify: `app/tracks/[id]/actions.ts` (`expandNodeAction`), `app/tracks/[id]/nodes/[nodeId]/actions.ts` (the daily-content action)
- Modify: `components/pensieve/ModelCallsPanel.tsx:186` (a key-owner chip)

**Interfaces:**
- Consumes: `resolveModels` (Task 5); `guardUserKey`, `guardUserKeyCall` (Task 8); the `outlineModel` / `model` / `defaultArm` options (Tasks 6, 7); `GenerationLogMeta.keyOwner` (Task 1).

- [ ] **Step 1: Draft route**

In `app/api/plan/draft/route.ts`, import `resolveModels` from `@/lib/ai/resolve` and `guardUserKey` from `@/lib/ai/userKeyError`. After the body is parsed:

```ts
  const models = await resolveModels(userId);

  return ndjsonResponse(
    withCallEvents(debug, { userId, onLog: insertGenerationLog, keyOwner: models.research.keyOwner }, (log) =>
      guardUserKey(
        streamResearchedPlanDraft({
          topic: body.topic,
          days: body.days,
          granularity: body.granularity,
          instructions: body.instructions || undefined,
          materials: body.materials,
          hoursPerWeek: body.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK,
          arm: defaultArm(process.env, { model: models.research.model }),
          outlineModel: models.outline,
          // A client that disconnects stops research: the signal reaches search and fetch.
          signal: request.signal,
          log,
        }),
        { userId, models },
      ),
    ),
  );
```

- [ ] **Step 2: Expand route**

Same imports. After parsing: `const models = await resolveModels(userId);`. The log context gains `keyOwner: models.outline.keyOwner`; the `streamExpandNode({...})` call gains `outlineModel: models.outline,` and is wrapped in `guardUserKey(..., { userId, models })`.

- [ ] **Step 3: Chat route**

Same imports. After the ownership check: `const models = await resolveModels(userId);`. The log context gains `keyOwner: models.chat.keyOwner`; the call becomes
```ts
      guardUserKey(
        runPlanChat({ ...body, days: tree.len, instructions: body.instructions || undefined, hoursPerWeek: body.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK, split: body.split ?? null, tree }, { log, model: models.chat, outlineModel: models.outline }),
        { userId, models },
      ),
```

- [ ] **Step 4: Track and node actions**

In `app/tracks/[id]/actions.ts`, `expandNodeAction`: after `getTrackDetail`, `const models = await resolveModels(userId);`; the `for await` iterates `guardUserKey(streamExpandNode({ ..., outlineModel: models.outline, log: { userId, trackId: input.trackId, onLog: insertGenerationLog, keyOwner: models.outline.keyOwner } }), { userId, models })`.

In `app/tracks/[id]/nodes/[nodeId]/actions.ts`: `const models = await resolveModels(userId);` before the generation; then
```ts
  const { content, costUsd } = await guardUserKeyCall(
    () =>
      generateDailyContent({
        title: node.title,
        summary: node.summary,
        unit: node.level === "day" ? "day" : "week",
        spanDays: node.len,
        materials,
        model: models.content,
        log: { trackId: input.trackId, userId, onLog: insertGenerationLog, keyOwner: models.content.keyOwner },
      }),
    { userId, models },
  );
```
The `upsertLeafContent` call keeps `model: DEFAULT_CONTENT_MODEL` replaced by `model: models.content.id`.

- [ ] **Step 5: The admin panel chip**

In `components/pensieve/ModelCallsPanel.tsx`, after the effort chip: `<Chip>{call.keyOwner === "user" ? "user's key" : "app key"}</Chip>`.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit -p . && npx eslint app/api/plan/draft/route.ts app/api/plan/expand/route.ts app/api/plan/chat/route.ts "app/tracks/[id]/actions.ts" "app/tracks/[id]/nodes/[nodeId]/actions.ts" components/pensieve/ModelCallsPanel.tsx && npx vitest run`
Expected: tsc and eslint clean; the whole suite passes (no route tests exist; the compiler is the check that every call site now passes a model and a guard).

- [ ] **Step 7: Commit**

```bash
git add app/api/plan/draft/route.ts app/api/plan/expand/route.ts app/api/plan/chat/route.ts "app/tracks/[id]/actions.ts" "app/tracks/[id]/nodes/[nodeId]/actions.ts" components/pensieve/ModelCallsPanel.tsx
git commit -m "feat: every request resolves its models once and is guarded for the user's key

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The settings page

**Files:**
- Create: `app/settings/actions.ts`, `app/settings/page.tsx`, `app/settings/ApiKeyCard.tsx`
- Modify: `components/pensieve/TopNav.tsx`, `README.md`
- Test: `app/settings/actions.test.ts`

**Interfaces:**
- Consumes: `detectProvider`, `verifyProviderKey`, `PROVIDER_NAMES` (Task 4); `sealSecret` (Task 2); `upsertUserApiKey`, `deleteUserApiKey`, `getUserApiKeys` (Task 3); `DIRECT_PROVIDERS` (Task 5); `auth` from Clerk.
- Produces: `saveApiKeyAction(input: { key: string }): Promise<{ ok: true; provider: ModelProvider; last4: string } | { ok: false; message: string }>`; `removeApiKeyAction(input: { provider: ModelProvider }): Promise<void>`; and a pure `prepareKey(raw: string): { ok: true; provider: ModelProvider; key: string } | { ok: false; message: string }` exported for the test.

- [ ] **Step 1: Write the failing test**

`app/settings/actions.test.ts` tests the pure part (the actions themselves need Clerk and the database and are checked in Chrome):

```ts
import { describe, expect, it } from "vitest";
import { prepareKey } from "./actions";

describe("prepareKey", () => {
  it("accepts a trimmed Anthropic key", () => {
    expect(prepareKey("  sk-ant-api03-abcdef\n")).toEqual({ ok: true, provider: "anthropic", key: "sk-ant-api03-abcdef" });
  });

  it("refuses other vendors' keys and unrecognised strings with the spec's messages", () => {
    expect(prepareKey("sk-proj-abc")).toEqual({ ok: false, message: "That looks like an OpenAI key. Pensieve runs on Claude models, so it can't be used yet. Nothing was saved." });
    expect(prepareKey("AIzaSyAbc")).toEqual({ ok: false, message: "That looks like a Google key. Pensieve runs on Claude models, so it can't be used yet. Nothing was saved." });
    expect(prepareKey("hello")).toEqual({ ok: false, message: "That key isn't one Pensieve recognises. Nothing was saved." });
    expect(prepareKey("   ")).toEqual({ ok: false, message: "That key isn't one Pensieve recognises. Nothing was saved." });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/settings/actions.test.ts`
Expected: FAIL, module `./actions` not found.

Note: `"use server"` files can export only async functions. Put `prepareKey` in `app/settings/prepareKey.ts` (no directive) and have the test import from there instead: change the import to `import { prepareKey } from "./prepareKey";`.

- [ ] **Step 3: Write `app/settings/prepareKey.ts`**

```ts
import type { ModelProvider } from "@/lib/ai/models";
import { PROVIDER_NAMES, detectProvider } from "@/lib/ai/providerKeys";
import { DIRECT_PROVIDERS } from "@/lib/ai/resolve";

export type PreparedKey = { ok: true; provider: ModelProvider; key: string } | { ok: false; message: string };

/** Trims the pasted key, names its vendor, and refuses vendors the app cannot route to yet. Pure; the action calls it first. */
export function prepareKey(raw: string): PreparedKey {
  const key = raw.trim();
  const provider = detectProvider(key);
  if (!provider) return { ok: false, message: "That key isn't one Pensieve recognises. Nothing was saved." };
  if (!DIRECT_PROVIDERS[provider]) {
    return { ok: false, message: `That looks like ${provider === "openai" ? "an" : "a"} ${PROVIDER_NAMES[provider]} key. Pensieve runs on Claude models, so it can't be used yet. Nothing was saved.` };
  }
  return { ok: true, provider, key };
}
```

- [ ] **Step 4: Write `app/settings/actions.ts`**

```ts
"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MODEL_PROVIDERS, type ModelProvider } from "@/lib/ai/models";
import { PROVIDER_NAMES, verifyProviderKey } from "@/lib/ai/providerKeys";
import { deleteUserApiKey, upsertUserApiKey } from "@/lib/db/userApiKeys";
import { sealSecret } from "@/lib/secrets";
import { prepareKey } from "./prepareKey";

const keySchema = z.string().min(1).max(500);

export type SaveApiKeyResult = { ok: true; provider: ModelProvider; last4: string } | { ok: false; message: string };

/** Detects, verifies, encrypts and stores a key. Never returns it. */
export async function saveApiKeyAction(input: { key: string }): Promise<SaveApiKeyResult> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  const parsed = keySchema.safeParse(input.key);
  if (!parsed.success) return { ok: false, message: "That key isn't one Pensieve recognises. Nothing was saved." };

  const prepared = prepareKey(parsed.data);
  if (!prepared.ok) return prepared;

  const check = await verifyProviderKey(prepared.provider, prepared.key);
  if (!check.ok) {
    return check.reason === "invalid"
      ? { ok: false, message: `That key was not accepted by ${PROVIDER_NAMES[prepared.provider]}. Nothing was saved.` }
      : { ok: false, message: `${PROVIDER_NAMES[prepared.provider]} could not be reached to check the key. Try again in a moment.` };
  }

  const sealed = sealSecret(prepared.key);
  await upsertUserApiKey({ userId, provider: prepared.provider, ciphertext: sealed.ciphertext, last4: prepared.key.slice(-4), secretVersion: sealed.version });
  revalidatePath("/settings");
  return { ok: true, provider: prepared.provider, last4: prepared.key.slice(-4) };
}

export async function removeApiKeyAction(input: { provider: ModelProvider }): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  const provider = z.enum(MODEL_PROVIDERS).parse(input.provider);
  await deleteUserApiKey(userId, provider);
  revalidatePath("/settings");
}
```

- [ ] **Step 5: Write `app/settings/ApiKeyCard.tsx`** (client component)

```tsx
"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { KeyErrorKind, ModelProvider } from "@/lib/ai/models";
import { removeApiKeyAction, saveApiKeyAction } from "./actions";

export interface StoredKey {
  provider: ModelProvider;
  providerName: string;
  last4: string;
  addedAt: string; // formatted on the server
  lastError: KeyErrorKind | null;
  lastErrorAgo: string | null; // "2 hours ago", formatted on the server
}

const ERROR_LINES: Record<KeyErrorKind, string> = {
  credits: "credits exhausted. Anthropic stopped requests until your next monthly credits arrive. Add credits or turn on auto-reload in the Console, or remove the key to use Pensieve's.",
  invalid: "the key was rejected. Replace it, or remove it to use Pensieve's.",
  rate_limit: "rate-limited. Try again in a minute.",
  other: "an error from the provider. Try again; if it keeps happening, check the Console.",
};

export function ApiKeyCard({ stored }: { stored: StoredKey | null }) {
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const result = await saveApiKeyAction({ key });
      setMessage(result.ok ? null : result.message);
      if (result.ok) setKey("");
    });
  const remove = (provider: ModelProvider) => start(async () => void (await removeApiKeyAction({ provider })));

  return (
    <div className="rounded-xl bg-card p-5 text-sm text-card-foreground ring-1 ring-foreground/10">
      <h3 className="font-heading text-[18px]">API key</h3>
      {stored ? (
        <>
          <p className="mt-1 text-muted-foreground">Your drafts, research, daily content and chat run on this key. Usage appears on your Console&apos;s cost page.</p>
          {stored.lastError && (
            <p className="mt-3 rounded-lg border-l-2 border-primary bg-primary/10 px-3 py-2">
              <b>Last request refused {stored.lastErrorAgo}:</b> {ERROR_LINES[stored.lastError]}{" "}
              <a className="underline" href="https://platform.claude.com/settings/billing" target="_blank" rel="noreferrer">Console billing</a>
            </p>
          )}
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-background px-3 py-2">
            <span>{stored.providerName} key ending in <code className="font-mono">…{stored.last4}</code></span>
            <span className="text-xs text-muted-foreground">added {stored.addedAt}</span>
            <Button variant="secondary" disabled={pending} onClick={() => remove(stored.provider)}>Remove</Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">To change keys, remove this one and save another. The key itself is never shown.</p>
        </>
      ) : (
        <>
          <p className="mt-1 text-muted-foreground">
            Pensieve runs on Claude models, so the key has to be an Anthropic key for now. Claude Max and Team plans include monthly API credits; Pro and Free don&apos;t, but a key with a card behind it works the same way.
          </p>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <Input type="password" autoComplete="off" placeholder="Paste your key" value={key} onChange={(e) => setKey(e.target.value)} />
            <Button type="submit" disabled={pending || key.trim().length === 0}>Save key</Button>
          </form>
          {message && <p className="mt-2 text-sm text-red-700">{message}</p>}
          <details className="mt-3 text-[13px]">
            <summary className="cursor-pointer text-primary">How to get a key that spends your plan&apos;s credits</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>On claude.ai, open <b>Settings → Billing → API credits</b> and link a Console organization (or create one). Credits arrive each billing cycle.</li>
              <li>In the <a className="underline" href="https://platform.claude.com/" target="_blank" rel="noreferrer">Claude Console</a>, signed in with the same email, create a workspace for Pensieve and give it a <b>spend limit</b>. Any key in the organization can spend the whole balance; the limit caps what this one can.</li>
              <li>Create an API key in that workspace and paste it above. Pensieve stores it encrypted and never shows it again.</li>
            </ol>
            <p className="mt-2 text-xs text-muted-foreground">When your credits run out, generations stop with a message rather than falling back to Pensieve&apos;s key. Add credits or turn on auto-reload in the Console to continue.</p>
          </details>
        </>
      )}
      <p className="mt-3 text-xs text-muted-foreground">Without a key, Pensieve pays. <Link className="underline" href="/dashboard">Back to the dashboard</Link></p>
    </div>
  );
}
```

- [ ] **Step 6: Write `app/settings/page.tsx`** (server component)

```tsx
import { auth } from "@clerk/nextjs/server";
import { PageShell } from "@/components/pensieve/PageShell";
import { PROVIDER_NAMES } from "@/lib/ai/providerKeys";
import { getUserApiKeys } from "@/lib/db/userApiKeys";
import { ApiKeyCard, type StoredKey } from "./ApiKeyCard";

function ago(from: Date, now = new Date()): string {
  const minutes = Math.max(1, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export default async function SettingsPage() {
  const { userId } = await auth();
  if (!userId) return null;
  const rows = await getUserApiKeys(userId);
  const row = rows.find((r) => r.provider === "anthropic") ?? null;
  const stored: StoredKey | null = row && {
    provider: row.provider,
    providerName: PROVIDER_NAMES[row.provider],
    last4: row.last4,
    addedAt: row.updatedAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
    lastError: row.lastError,
    lastErrorAgo: row.lastErrorAt ? ago(row.lastErrorAt) : null,
  };

  return (
    <PageShell>
      <div className="pb-7">
        <h1 className="font-heading text-[26px]">Settings</h1>
        <p className="text-muted-foreground">Pay for your own usage with an API key. Without one, Pensieve pays.</p>
      </div>
      <div className="max-w-[620px]">
        <ApiKeyCard stored={stored} />
      </div>
    </PageShell>
  );
}
```

- [ ] **Step 7: The nav link and the README**

In `components/pensieve/TopNav.tsx`, before the admin toggle: `<Link href="/settings" className="text-sm text-foreground/80 hover:text-foreground">Settings</Link>`.

In `README.md`'s Environment list, add:
```
- `USER_KEY_ENCRYPTION_SECRET`: encrypts the API keys users store in Settings (AES-256-GCM). 32 random bytes, base64:
  `openssl rand -base64 32`. Without it, saving a key fails; nothing is ever stored in plaintext.
```

- [ ] **Step 8: Verify**

Run: `npx vitest run app/settings/actions.test.ts && npx tsc --noEmit -p . && npx eslint app/settings components/pensieve/TopNav.tsx`
Expected: PASS, clean, clean.

Then, with `USER_KEY_ENCRYPTION_SECRET` set in `.env.local` and the dev server running, in the operator's Chrome: `/settings` shows the no-key card; pasting `sk-proj-x` shows the OpenAI refusal; pasting `hello` shows the unrecognised message; pasting a real Anthropic key shows the stored state with its last four characters; Remove returns to the no-key card.

- [ ] **Step 9: Commit**

```bash
git add app/settings README.md components/pensieve/TopNav.tsx
git commit -m "feat(settings): a page to store, check and remove the user's own API key

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The workspace shows the error with a way out

**Files:**
- Modify: `components/pensieve/PlanWorkspace.tsx:114` (state), the three `event.type === "error"` branches, and the error rendering near line 639.

- [ ] **Step 1: Carry the code**

Add state beside `error`: `const [errorCode, setErrorCode] = useState<string | null>(null);`.

In each of the three branches that read `throw new Error(event.message)` on an `error` event, throw `Object.assign(new Error(event.message), { code: event.code })` instead. Where the surrounding `catch` sets `setError(...)`, also set `setErrorCode(typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : null)`. Where `setError(null)` resets, also `setErrorCode(null)`.

Render:
```tsx
          {error && (
            <p className="text-sm text-red-600">
              {error}
              {errorCode && (
                <>
                  {" "}
                  <Link href="/settings" className="underline">Open Settings</Link>
                </>
              )}
            </p>
          )}
```
Import `Link` from `next/link` if the file does not already.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit -p . && npx eslint components/pensieve/PlanWorkspace.tsx`
Expected: clean.

In Chrome, with a stored key whose Console organization has no credits (or by temporarily revoking the key in the Console): start a draft; it stops with the credits (or rejected) message and the Settings link; `/settings` shows "Last request refused … ago". Then restore credits or the key, draft again, and confirm the refusal line clears.

- [ ] **Step 3: Commit**

```bash
git add components/pensieve/PlanWorkspace.tsx
git commit -m "feat(ui): a refused user key shows its message with a link to Settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: End-to-end check on the operator's key, then finish

- [ ] **Step 1: Full verification**

Run: `npx vitest run && npx tsc --noEmit -p . && npm run lint`
Expected: all pass, clean, clean.

- [ ] **Step 2: Live check (operator)**

Operator steps, not automatable: set `USER_KEY_ENCRYPTION_SECRET` in Vercel (production and preview) and in `.env.local`; apply the migration to production with `npx drizzle-kit migrate` from a terminal before deploying; deploy. Then save a Max key on `/settings`, run one draft, and confirm three things: the admin model-calls panel shows "user's key" on every research and drafting row; the Console's cost page shows the usage; the gateway dashboard shows none for that draft. Remove the key, draft again, and confirm the rows read "app key".

- [ ] **Step 3: Spec status**

In `docs/superpowers/specs/2026-10-15-user-api-keys-design.md`, change the status line to `**Status:** built on <date> (plan: docs/superpowers/plans/2026-10-15-user-api-keys.md); live-checked on the operator's Max key.` Commit with `docs(spec): user API keys built`.

- [ ] **Step 4: Finish the branch**

Use the superpowers:finishing-a-development-branch skill: open the PR against `main` with a description covering the eight decisions, the migration-first order, the env var, and the Chrome checks; end the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
