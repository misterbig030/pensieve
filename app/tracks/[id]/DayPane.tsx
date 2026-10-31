import type { ReactNode } from "react";
import Link from "next/link";
import { BookOpen, CircleCheck } from "lucide-react";
import { getLeafWithContent } from "@/lib/db/planQueries";
import { firstParagraph } from "@/lib/lessonPreview";
import { budgetFor, doneDays, fullLabelOf, isHeading, labelOf, spanOf, weeksOf, type PlanNode } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import { formatDayTime, totalHours } from "@/lib/studyTime";
import { CoversRow } from "@/components/pensieve/PlanTree";
import { Button } from "@/components/ui/button";
import { practiceRowsFor, readRowsFor, sumMinutes, sumPracticeMinutes } from "@/components/pensieve/ReadTable";
import { DoRows, ReadRows } from "./PaneRows";
import { GenerateLessonButton } from "@/components/pensieve/leaf/GenerateLessonButton";
import { LogSessionForm } from "@/components/pensieve/leaf/LogSessionForm";
import { MarkCompleteButton } from "@/components/pensieve/leaf/MarkCompleteButton";
import { PlanUnitButton } from "@/components/pensieve/leaf/PlanUnitButton";

interface Props {
  trackId: string;
  root: PlanNode;
  node: PlanNode;
  currentLeafId: string | null;
  materials: Material[];
  hoursPerWeek: number;
  daysPerWeek: number;
  userId: string;
}

function Box({ title, minutes, children }: { title: string; minutes: number; children: ReactNode }) {
  return (
    <section className="min-w-0 flex-1 rounded-[20px] bg-secondary px-4 py-3.5">
      <h4 className="mb-2 flex text-[11px] font-semibold tracking-[.04em] text-foreground/45 uppercase">
        {title}
        {minutes > 0 && <span className="ml-auto font-medium tracking-normal normal-case">{formatDayTime(minutes)}</span>}
      </h4>
      {children}
    </section>
  );
}

function Heading({ kicker, title, summary }: { kicker: string; title: string; summary: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-[.04em] text-primary uppercase">{kicker}</span>
      <h2 className="font-heading text-[26px] leading-[1.15]">{title}</h2>
      {summary && <p className="text-[14px] leading-relaxed text-foreground/75">{summary}</p>}
    </div>
  );
}

/** A unit that isn't a lesson: a week or month with its days, or one not planned yet. */
export function UnitPane({ trackId, root, node, materials, daysPerWeek, hoursPerWeek }: Props) {
  const heading = isHeading(node);
  const done = !heading && doneDays(node) >= node.len;
  const label = labelOf(root, node);
  const hours = node.budgetHours ?? totalHours(weeksOf(root, node, daysPerWeek), hoursPerWeek);
  return (
    <div className="flex flex-col gap-4">
      <Heading kicker={`${fullLabelOf(root, node)} · ${spanOf(root, node, daysPerWeek)} · about ${hours} h`} title={node.title} summary={node.summary} />
      {heading ? (
        <>
          <CoversRow node={node} byId={new Map(materials.map((m) => [m.id, m]))} />
          <div className="flex flex-wrap items-center gap-3 rounded-[20px] border border-dashed border-neutral-400 px-4 py-3.5 text-[13.5px]">
            <span className="text-muted-foreground">{label} isn&apos;t planned yet.</span>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <PlanUnitButton trackId={trackId} nodeId={node.id} reason="expand" label={`Plan ${label}`} daysPerWeek={daysPerWeek} hoursPerWeek={hoursPerWeek} />
            </span>
          </div>
        </>
      ) : (
        <>
          {done && (
            <p className="flex items-center gap-2 text-[14px] font-semibold text-accent-2-700">
              <CircleCheck className="size-4" />
              Done
            </p>
          )}
          <ul className="flex flex-col divide-y divide-border rounded-[20px] bg-secondary px-4">
            {(node.children ?? []).map((child) => (
              <li key={child.id}>
                <Link href={`?day=${child.id}`} scroll={false} className="flex items-center gap-2.5 py-2.5 text-[13.5px] hover:text-primary">
                  <span className="w-14 shrink-0 text-[12px] text-muted-foreground">{labelOf(root, child)}</span>
                  <span className="min-w-0 flex-1 truncate">{child.title}</span>
                  {child.status === "completed" && <CircleCheck className="size-4 shrink-0 text-accent-2-600" />}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The selected day (or week leaf): what to read and do, the lesson, and the ways to finish it. */
async function LeafPane({ trackId, root, node, currentLeafId, materials, hoursPerWeek, daysPerWeek, userId }: Props) {
  const leaf = await getLeafWithContent(node.id, userId);
  const byId = new Map(materials.map((m) => [m.id, m]));
  const readRows = readRowsFor(node.materials, byId);
  const practiceRows = practiceRowsFor(node.practice, byId);
  const read = sumMinutes(readRows);
  const readMinutes = read.must + read.should;
  const practiceMinutes = sumPracticeMinutes(practiceRows);
  const isWeek = node.level !== "day";
  const done = node.status === "completed";
  const content = leaf?.content?.contentMarkdown ?? null;
  const sessions = (leaf?.sessions ?? []).flatMap((s) => (s.hours === null ? [] : [{ hours: s.hours }]));
  const splittable = isWeek && !done && sessions.length === 0;
  const preview = content ? firstParagraph(content) : "";

  return (
    <div className="flex flex-col gap-4">
      <Heading kicker={`${fullLabelOf(root, node)}${node.id === currentLeafId ? " · Today" : ""}`} title={node.title} summary={node.summary} />

      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          nativeButton={false}
          render={
            <Link href={`/tracks/${trackId}/nodes/${node.id}`}>
              <BookOpen />
              Open lesson
            </Link>
          }
        />
        {done ? (
          <span className="flex items-center gap-1.5 text-[13.5px] font-semibold text-accent-2-700">
            <CircleCheck className="size-4" />
            Completed
          </span>
        ) : (
          content && <MarkCompleteButton nodeId={node.id} completed={false} />
        )}
        {splittable && <PlanUnitButton trackId={trackId} nodeId={node.id} reason="split" label="Split into days" daysPerWeek={daysPerWeek} hoursPerWeek={hoursPerWeek} />}
        {readMinutes + practiceMinutes > 0 && (
          <span className="text-[12.5px] text-muted-foreground">
            {formatDayTime(readMinutes + practiceMinutes)} · {formatDayTime(readMinutes)} reading, {formatDayTime(practiceMinutes)} practice
          </span>
        )}
      </div>

      {isWeek && <LogSessionForm nodeId={node.id} budgetHours={node.budgetHours ?? budgetFor(1, hoursPerWeek)} sessions={sessions} />}

      {(readRows.length > 0 || practiceRows.length > 0) && (
        <div className="flex gap-3 max-[1100px]:flex-col">
          {readRows.length > 0 && (
            <Box title="Read" minutes={readMinutes}>
              <ReadRows rows={readRows} />
            </Box>
          )}
          {practiceRows.length > 0 && (
            <Box title="Do" minutes={practiceMinutes}>
              <DoRows rows={practiceRows} />
            </Box>
          )}
        </div>
      )}

      <section className="elev-sm flex flex-col gap-2.5 rounded-[24px] bg-neutral-100 px-5 py-4">
        {content ? (
          <>
            <h4 className="flex items-center gap-2 text-[13px] font-semibold text-accent-2-700">
              <CircleCheck className="size-4" />
              {readRows.length > 0 ? `Lesson ready · written from ${readRows.length} material${readRows.length === 1 ? "" : "s"}` : "Lesson ready"}
            </h4>
            {preview && <p className="text-[14px] leading-relaxed text-foreground/80">{preview}</p>}
            <Link href={`/tracks/${trackId}/nodes/${node.id}`} className="text-[13px] font-semibold text-primary hover:underline">
              Read the lesson
            </Link>
          </>
        ) : (
          <>
            <h4 className="text-[15px] font-semibold">{isWeek ? "This week's material isn't written yet" : "Today's lesson isn't written yet"}</h4>
            <p className="text-[13.5px] text-muted-foreground">
              {readRows.length > 0
                ? `Written from the ${readRows.length === 1 ? "material" : `${readRows.length} materials`} above, and citing only ${readRows.length === 1 ? "it" : "them"}. Generate it when you start.`
                : "Generate it now — Pensieve will pull in your sources and cite what it uses."}
            </p>
            <div className="flex flex-col items-start gap-1.5">
              <GenerateLessonButton trackId={trackId} nodeId={node.id} unit={isWeek ? "week" : "day"} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/** The right side of the plan tab: the row picked in the outline. */
export async function DayPane(props: Props) {
  const { node } = props;
  return node.children === null && !isHeading(node) ? <LeafPane {...props} /> : <UnitPane {...props} />;
}
