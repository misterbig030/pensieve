import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { getTrackDetail } from "@/lib/db/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default async function TrackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { userId } = await auth();
  if (!userId) return null;

  const { id } = await params;
  const detail = await getTrackDetail(id, userId);
  if (!detail) notFound();

  const { track, items } = detail;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{track.title}</h1>
        <Button
          variant="secondary"
          render={<Link href={`/tracks/${track.id}/adjust`}>调整计划</Link>}
        />
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={`/tracks/${track.id}/day/${item.dayIndex}`}
              className="flex items-center justify-between rounded border p-3 hover:bg-muted"
            >
              <span>Day {item.dayIndex}: {item.title}</span>
              <Badge variant={item.status === "completed" ? "default" : "secondary"}>
                {item.status}
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
