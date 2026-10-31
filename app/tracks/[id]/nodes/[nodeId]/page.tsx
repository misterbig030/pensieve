import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { getTrackDetail, sourceToMaterial } from "@/lib/db/queries";
import { getLeafWithContent, getNodeReadList } from "@/lib/db/planQueries";
import { budgetMinutes } from "@/lib/materials";
import { ChevronRight } from "lucide-react";
import { budgetFor, currentLeaf, daysInWeekOf, findNode, fullLabelOf, neighbours, type PlanNode } from "@/lib/planTree";
import { PageShell } from "@/components/pensieve/PageShell";
import { byTier, practiceRowsFor, type ReadRow } from "@/components/pensieve/ReadTable";
import { chapterAt } from "@/lib/schemas/material";
import { LeafView, type LeafLink } from "./LeafView";

export default async function LeafPage({ params }: { params: Promise<{ id: string; nodeId: string }> }) {
  const { userId } = await auth();
  if (!userId) return null;

  const { id, nodeId } = await params;
  const [detail, leaf, trackSources] = await Promise.all([
    getTrackDetail(id, userId),
    getLeafWithContent(nodeId, userId),
    db.query.sources.findMany({ where: eq(sources.trackId, id) }),
  ]);
  if (!detail || !leaf || leaf.node.trackId !== id) notFound();
  const readList = await getNodeReadList(nodeId);
  const readRows: ReadRow[] = readList
    .map((r): ReadRow => {
      const material = sourceToMaterial(r.source);
      return { material, tier: r.tier ?? "should", minutes: r.minutes, note: r.note, chapter: chapterAt(material.toc, r.chapter || null), activity: r.activity, key: `${material.id}#${r.chapter}` };
    })
    .sort(byTier);

  const node = findNode(detail.root, nodeId);
  if (!node || node.children !== null) notFound();

  const trackMaterials = new Map(trackSources.map((s) => [s.id, sourceToMaterial(s)]));
  const practiceRows = practiceRowsFor(node.practice, trackMaterials);

  const kicker = fullLabelOf(detail.root, node);
  const isWeek = node.level !== "day";
  const hours = detail.track.hoursPerWeek;
  const days = daysInWeekOf(detail.root, node, detail.track.daysPerWeek);
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
        practiceRows={practiceRows}
        budgetMinutes={budgetMinutes({ level: node.level, budgetHours: isWeek ? (node.budgetHours ?? budgetFor(1, hours)) : null }, hours, days)}
        isCompleted={node.status === "completed"}
      />
    </PageShell>
  );
}
