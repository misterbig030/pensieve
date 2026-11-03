import { userRowFor } from "@/lib/db/users";

/**
 * Staff-only surfaces are gated by `users.is_admin`. Server-side only; the client learns whether it is admin from a prop
 * and the server re-checks on every request that would reveal more.
 */
export async function isAdmin(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  return (await userRowFor(userId))?.isAdmin ?? false;
}
