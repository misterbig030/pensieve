import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { getTrackDetail } from "@/lib/db/queries";
import { getLeafWithContent } from "@/lib/db/planQueries";
import { budgetFor, findNode, labelOf, spanOf } from "@/lib/planTree";
import { PageShell } from "@/components/pensieve/PageShell";
import { LeafView } from "./LeafView";

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

  const node = findNode(detail.root, nodeId);
  if (!node || node.children !== null) notFound();

  const label = labelOf(detail.root, node);
  const kicker = node.level === "day" ? label : `${label} · ${spanOf(node)}`;
  const isWeek = node.level !== "day";
  const sessions = leaf.sessions.filter((s) => s.hours !== null);
  const youtubeSources = trackSources.filter((s) => s.type === "youtube");

  return (
    <PageShell>
      <div className="mx-auto max-w-[640px] space-y-5">
        <div className="text-[13px] text-foreground/60">
          <Link href={`/tracks/${id}`} className="hover:text-primary">
            ← {detail.track.title}
          </Link>
        </div>
        <div className="space-y-2 pb-1">
          <span className="text-[10px] tracking-wide text-primary uppercase">{kicker}</span>
          <h1>{node.title}</h1>
          <p className="text-muted-foreground">{node.summary}</p>
        </div>
        <LeafView
          trackId={id}
          nodeId={nodeId}
          unit={isWeek ? "week" : "day"}
          budgetHours={isWeek ? (node.budgetHours ?? budgetFor(node.len)) : null}
          initialSessions={sessions.map((s) => ({ hours: s.hours as number }))}
          initialContent={
            leaf.content
              ? { contentMarkdown: leaf.content.contentMarkdown, citations: leaf.content.citations as { title: string; url: string }[] }
              : null
          }
          youtubeSources={youtubeSources.map((s) => ({ title: s.title, url: s.url }))}
          isCompleted={node.status === "completed"}
        />
      </div>
    </PageShell>
  );
}
