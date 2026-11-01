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

/** `getUserRow` once per request: the admin check and the credits both read it. */
export const userRowFor = cache(getUserRow);

/** The signup date as Clerk recorded it. */
export async function clerkSignupDate(userId: string): Promise<Date> {
  const user = await (await clerkClient()).users.getUser(userId);
  return new Date(user.createdAt);
}

/** When the user signed up: from their row, or asked of Clerk once and kept there. */
export async function signedUpAt(userId: string, lookup: (userId: string) => Promise<Date> = clerkSignupDate): Promise<Date> {
  const stored = (await userRowFor(userId))?.signedUpAt;
  if (stored) return stored;
  const at = await lookup(userId);
  await db.insert(users).values({ id: userId, signedUpAt: at }).onConflictDoUpdate({ target: users.id, set: { signedUpAt: at } });
  return at;
}
