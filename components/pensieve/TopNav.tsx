import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { getCheckInDatesForUser } from "@/lib/db/queries";
import { computeStreak } from "@/lib/streak";
import { Button } from "@/components/ui/button";
import { StreakChip } from "@/components/pensieve/StreakChip";

export async function TopNav() {
  const { userId } = await auth();
  const streak = userId ? computeStreak(await getCheckInDatesForUser(userId)) : 0;

  return (
    <div className="flex items-center gap-4 pt-7 pb-10">
      <Link href="/dashboard" className="mr-auto flex items-center gap-2.5">
        <span className="size-7 shrink-0 rounded-full bg-primary" />
        <span className="font-heading text-[19px]">Pensieve</span>
      </Link>
      <StreakChip days={streak} />
      <Button nativeButton={false} render={<Link href="/tracks/new">+ New track</Link>} />
    </div>
  );
}
