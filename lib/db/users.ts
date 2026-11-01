import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { db } from "./client";
import type { Tx } from "./planQueries";
import { users, type User } from "./schema";

/** Makes the user's row if it is missing, so a track or key can point at it. No Clerk call: the signup date waits. */
export async function ensureUser(executor: typeof db | Tx, userId: string): Promise<void> {
  await executor.insert(users).values({ id: userId }).onConflictDoNothing();
}

export async function getUserRow(userId: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row ?? null;
}

/**
 * `getUserRow` once per page render, where the admin check and the credits share it. React's `cache` only memoizes
 * inside a server component render: in route handlers and server actions every call reads the row again.
 */
export const userRowFor = cache(getUserRow);

/** The signup date as Clerk recorded it. */
export async function clerkSignupDate(userId: string): Promise<Date> {
  const user = await (await clerkClient()).users.getUser(userId);
  return new Date(user.createdAt);
}

/** How long a page or route waits on Clerk for a signup date before going on without it. */
export const CLERK_LOOKUP_TIMEOUT_MS = 3000;

function withinTime<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Clerk signup lookup timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * When the user signed up: from their row, or asked of Clerk once and kept there. Rejects when Clerk fails or is slower
 * than `timeoutMs`; nothing is kept then, so the next request asks again.
 */
export async function signedUpAt(
  userId: string,
  lookup: (userId: string) => Promise<Date> = clerkSignupDate,
  timeoutMs: number = CLERK_LOOKUP_TIMEOUT_MS,
): Promise<Date> {
  const stored = (await userRowFor(userId))?.signedUpAt;
  if (stored) return stored;
  const at = await withinTime(lookup(userId), timeoutMs);
  await db.insert(users).values({ id: userId, signedUpAt: at }).onConflictDoUpdate({ target: users.id, set: { signedUpAt: at } });
  return at;
}

/** `signedUpAt` once per page render: a second caller in the same render neither asks Clerk nor writes again. */
export const signedUpAtFor = cache((userId: string) => signedUpAt(userId));
