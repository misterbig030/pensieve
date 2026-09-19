/**
 * Staff-only surfaces are gated by `ADMIN_USER_IDS`: a comma-separated list of Clerk user ids. Server-side only; the
 * client learns whether it is admin from a prop and the server re-checks on every request that would reveal more.
 */
export function adminUserIds(raw: string | undefined = process.env.ADMIN_USER_IDS): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isAdminUserId(userId: string | null | undefined, raw?: string): boolean {
  if (!userId) return false;
  return adminUserIds(raw ?? process.env.ADMIN_USER_IDS).has(userId);
}
