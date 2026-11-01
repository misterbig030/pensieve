import { auth, currentUser } from "@clerk/nextjs/server";
import { PageShell } from "@/components/pensieve/PageShell";
import { PROVIDER_NAMES } from "@/lib/ai/providerKeys";
import { getUserApiKeys } from "@/lib/db/userApiKeys";
import { AccountCard } from "./AccountCard";
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
  const [rows, user] = await Promise.all([getUserApiKeys(userId), currentUser()]);
  const row = rows.find((r) => r.provider === "anthropic") ?? null;
  const stored: StoredKey | null = row
    ? {
        provider: row.provider,
        providerName: PROVIDER_NAMES[row.provider],
        last4: row.last4,
        addedAt: row.updatedAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
        lastError: row.lastError,
        lastErrorAgo: row.lastErrorAt ? ago(row.lastErrorAt) : null,
      }
    : null;

  return (
    <PageShell className="mx-auto max-w-[960px]">
      <div className="pb-7">
        <h1 className="font-heading text-[26px]">Settings</h1>
        <p className="text-muted-foreground">Pay for your own usage with an API key. Without one, Pensieve pays.</p>
      </div>
      <div className="flex max-w-[620px] flex-col gap-5">
        <ApiKeyCard stored={stored} />
        <AccountCard email={user?.primaryEmailAddress?.emailAddress ?? null} />
      </div>
    </PageShell>
  );
}
