import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { budgetFor, currentLeaf, fullLabelOf, neighbours, type PlanNode } from "@/lib/planTree";
import { PageShell } from "@/components/pensieve/PageShell";
import { LeafView, type LeafLink } from "./LeafView";
import { loadDay } from "./loadDay";

export default async function LeafPage({ params }: { params: Promise<{ id: string; nodeId: string }> }) {
  const { userId } = await auth();
  if (!userId) return null;

  const { id, nodeId } = await params;
  const day = await loadDay(id, nodeId, userId);
  if (!day) notFound();
  const { detail, leaf, node, trackSources, readRows, tasks } = day;

  const kicker = fullLabelOf(detail.root, node);
  const isWeek = node.level !== "day";
  const hours = detail.track.hoursPerWeek;
  const sessions = leaf.sessions.filter((s) => s.hours !== null);
  // The lesson's videos are the leaf's own when it has a Read table; older plans fall back to every video on the track.
  const youtubeSources =
    readRows.length > 0
      ? readRows.filter((r) => r.material.type === "youtube").map((r) => ({ title: r.material.title, url: r.material.url }))
      : trackSources.filter((s) => s.type === "youtube").map((s) => ({ title: s.title, url: s.url }));

  const { prev, next } = neighbours(detail.root, nodeId);
  const leafLink = (n: PlanNode | null): LeafLink | null => (n ? { href: `/tracks/${id}/nodes/${n.id}`, label: fullLabelOf(detail.root, n), title: n.title } : null);
  const isToday = currentLeaf(detail.root)?.id === nodeId;

  const header = (
    <>
      <nav className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
        <Link href="/" className="shrink-0 hover:text-primary">
          Your tracks
        </Link>
        <ChevronRight className="size-3.5 shrink-0" />
        <Link href={`/tracks/${id}`} className="truncate hover:text-primary">
          {detail.track.title}
        </Link>
        <ChevronRight className="size-3.5 shrink-0" />
        <b className="shrink-0 font-semibold text-foreground">{kicker}</b>
      </nav>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold tracking-[.05em] text-primary uppercase">
          {kicker}
          {isToday && " · Today"}
        </span>
        <h1 className="font-heading text-[32px] leading-[1.1]">{node.title}</h1>
      </div>
      {node.summary && <p className="text-[15px] leading-[1.55] text-muted-foreground">{node.summary}</p>}
    </>
  );

  return (
    <PageShell className="p-0 max-[640px]:px-0">
      <LeafView
        header={header}
        unitLabel={kicker}
        prev={leafLink(prev)}
        next={leafLink(next)}
        trackId={id}
        nodeId={nodeId}
        unit={isWeek ? "week" : "day"}
        budgetHours={isWeek ? (node.budgetHours ?? budgetFor(1, hours)) : null}
        initialSessions={sessions.map((s) => ({ hours: s.hours as number }))}
        initialContent={
          leaf.content
            ? { contentMarkdown: leaf.content.contentMarkdown, citations: leaf.content.citations as { title: string; url: string }[] }
            : null
        }
        youtubeSources={youtubeSources}
        readRows={readRows}
        tasks={tasks}
        isCompleted={node.status === "completed"}
      />
    </PageShell>
  );
}
