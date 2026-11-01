import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { Coins, Flame } from "lucide-react";
import { creditStatusFor } from "@/lib/db/creditStatus";
import { getCheckInDatesForUser } from "@/lib/db/queries";
import { isAdminUserId } from "@/lib/admin";
import { computeStreak } from "@/lib/streak";
import { cn } from "@/lib/utils";
import { AccountMenu } from "@/components/pensieve/AccountMenu";
import { NavTabs } from "@/components/pensieve/NavTabs";

/** The full-width bar on every signed-in page: brand, section tabs, streak and the account menu. */
export async function TopBar() {
  const { userId } = await auth();
  // The credits pill is extra: a failed lookup hides it rather than taking down every page's bar.
  const [dates, credits] = userId
    ? await Promise.all([getCheckInDatesForUser(userId), creditStatusFor(userId).catch(() => null)])
    : [[], null];
  const streak = computeStreak(dates);

  return (
    <header className="flex h-[60px] items-stretch gap-8 border-b border-border px-8 max-[768px]:gap-4 max-[640px]:px-4">
      <Link href="/" aria-label="Pensieve, home" className="flex items-center gap-2.5">
        <span className="size-7 shrink-0 rounded-full bg-primary" />
        <span className="font-heading text-[19px] max-[768px]:hidden">Pensieve</span>
      </Link>
      <NavTabs />
      <div className="ml-auto flex items-center gap-3">
        {credits && !credits.keyCoversAll && (
          <Link
            href="/settings#credits"
            title={`${credits.left} credits left this month`}
            aria-label={`${credits.left} credits left this month`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12.5px] font-semibold ring-1 outline-none hover:ring-primary/50 focus-visible:ring-2 focus-visible:ring-primary",
              credits.left === 0 ? "bg-red-50 text-red-600 ring-red-600/25" : "bg-neutral-100 text-neutral-700 ring-foreground/12",
            )}
          >
            <Coins className="size-3.5" />
            {credits.left}
          </Link>
        )}
        <span
          title={`${streak}-day streak`}
          className="inline-flex items-center gap-1 rounded-full bg-accent-100 px-2.5 py-1 text-[12.5px] font-semibold text-accent-800"
        >
          <Flame className="size-3.5" />
          {streak}
        </span>
        <AccountMenu admin={isAdminUserId(userId)} />
      </div>
    </header>
  );
}
