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
