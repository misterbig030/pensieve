import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { getTracksForUser, getCheckInDatesForUser } from "@/lib/db/queries";
import { computeStreak } from "@/lib/streak";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) return null;

  const [tracks, checkInDates] = await Promise.all([
    getTracksForUser(userId),
    getCheckInDatesForUser(userId),
  ]);
  const streak = computeStreak(checkInDates);

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-heading font-semibold">我的学习 · 连续打卡 {streak} 天</h1>
        <Button nativeButton={false} render={<Link href="/tracks/new">+ 新建 Track</Link>} />
      </div>
      <div className="grid gap-3">
        {tracks.map((track) => (
          <Link key={track.id} href={`/tracks/${track.id}`}>
            <Card>
              <CardHeader>
                <CardTitle>{track.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                状态：{track.status}
              </CardContent>
            </Card>
          </Link>
        ))}
        {tracks.length === 0 && (
          <p className="text-sm text-muted-foreground">还没有学习方向，点右上角新建一个吧。</p>
        )}
      </div>
    </div>
  );
}
