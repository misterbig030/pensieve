import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { getTrackDetail } from "@/lib/db/queries";
import { PageShell } from "@/components/pensieve/PageShell";
import { AdjustPlan } from "./AdjustPlan";

export default async function AdjustTrackPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { userId } = await auth();
  if (!userId) return null;

  const { id } = await params;
  const detail = await getTrackDetail(id, userId);
  if (!detail) notFound();

  const lastDone = detail.items.reduce(
    (max, item) => (item.status === "completed" ? Math.max(max, item.dayIndex) : max),
    0,
  );

  return (
    <PageShell>
      <AdjustPlan trackId={id} trackTitle={detail.track.title} lastDone={lastDone} />
    </PageShell>
  );
}
