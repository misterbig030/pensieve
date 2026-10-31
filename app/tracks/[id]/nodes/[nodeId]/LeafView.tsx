"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LessonMarkdown } from "@/components/pensieve/LessonMarkdown";
import { TierPill, partLabel, type PracticeRow, type ReadRow } from "@/components/pensieve/ReadTable";
import { ActionError } from "@/components/pensieve/leaf/ActionError";
import { LogSessionForm } from "@/components/pensieve/leaf/LogSessionForm";
import { MarkCompleteButton } from "@/components/pensieve/leaf/MarkCompleteButton";
import { formatCostUsd } from "@/lib/formatCost";
import { pushModelCalls } from "@/lib/modelCalls";
import { shortTitle } from "@/lib/shortTitle";
import { formatDayTime } from "@/lib/studyTime";
import { cn } from "@/lib/utils";
import { generateLeafContentAction } from "./actions";

interface Source {
  url: string;
  title: string | null;
}

/** A neighbouring day or week in the rail: where it goes, its label and its title. */
export interface LeafLink {
  href: string;
  label: string;
  title: string;
}

interface Props {
  trackId: string;
  nodeId: string;
  unit: "day" | "week";
  /** "Week 2 · Day 3": names the leaf on its Mark complete button. */
  unitLabel: string;
  /** The breadcrumb, kicker, title and lede, at the top of the reading column. */
  header: ReactNode;
  /** Week leaves only. */
  budgetHours: number | null;
  initialSessions: { hours: number }[];
  initialContent: { contentMarkdown: string; citations: { title: string; url: string }[] } | null;
  youtubeSources: Source[];
  isCompleted: boolean;
  /** The leaf's Read table; empty for plans saved before materials were assigned. */
  readRows: ReadRow[];
  practiceRows: PracticeRow[];
  budgetMinutes: number;
  prev: LeafLink | null;
  next: LeafLink | null;
}

function Tick({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px]",
        on ? "border-accent-2-500 bg-accent-2-500 text-background" : "border-neutral-400",
      )}
    >
      {on && <Check className="size-2.5" strokeWidth={3} />}
    </span>
  );
}

function TodoRow({ on, onToggle, children, minutes }: { on: boolean; onToggle(): void; children: ReactNode; minutes?: number | null }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} onClick={onToggle} className="flex w-full items-start gap-2.5 py-[7px] text-left text-[13px]">
      <Tick on={on} />
      <span className={cn("min-w-0 flex-1", on && "text-muted-foreground line-through decoration-foreground/30")}>{children}</span>
      {minutes != null && <span className="shrink-0 text-[12px] whitespace-nowrap text-muted-foreground">{minutes} min</span>}
    </button>
  );
}

function RailHeading({ children }: { children: ReactNode }) {
  return <h4 className="mb-1.5 text-[11px] font-semibold tracking-[.04em] text-foreground/45 uppercase">{children}</h4>;
}

export function LeafView({
  trackId,
  nodeId,
  unit,
  unitLabel,
  header,
  budgetHours,
  initialSessions,
  initialContent,
  youtubeSources,
  isCompleted,
  readRows,
  practiceRows,
  budgetMinutes,
  prev,
  next,
}: Props) {
  const [content, setContent] = useState(initialContent);
  const [sessions, setSessions] = useState(initialSessions);
  const [isPending, setIsPending] = useState(false);
  const [completed, setCompleted] = useState(isCompleted);
  const [error, setError] = useState<string | null>(null);
  /** True when the error is a refused user key, so the message links to Settings. */
  const [errorLink, setErrorLink] = useState(false);
  const [costUsd, setCostUsd] = useState<number | null>(null);
  /** Ticks on the rail's checklist. Kept for this visit only. */
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());

  const isWeek = unit === "week";
  const toggle = (key: string) =>
    setTicked((t) => {
      const next = new Set(t);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  async function handleGenerate() {
    setIsPending(true);
    setError(null);
    setErrorLink(false);
    try {
      const result = await generateLeafContentAction({ trackId, nodeId });
      if (result.calls) pushModelCalls(result.calls);
      if (!result.ok) {
        setError(result.message);
        setErrorLink(true);
      } else {
        setContent({ contentMarkdown: result.contentMarkdown, citations: result.citations });
        setCostUsd(result.costUsd);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed. Try again.");
    } finally {
      setIsPending(false);
    }
  }

  const provenance = readRows.length > 0 && <WhereTheseComeFrom rows={readRows} />;

  const main = content ? (
    <>
      <div className="space-y-4">
        <LessonMarkdown>{content.contentMarkdown}</LessonMarkdown>
      </div>
      {youtubeSources.length > 0 && (
        <div>
          <p className="mb-2.5 text-[11px] tracking-wide text-muted-foreground uppercase">Related video</p>
          <div className="flex flex-col gap-2">
            {youtubeSources.map((s) => (
              <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-2xl p-2 hover:bg-secondary">
                <span
                  className="h-10 w-16 shrink-0 rounded-[10px]"
                  style={{ backgroundImage: "repeating-linear-gradient(135deg, var(--neutral-300) 0 6px, var(--neutral-200) 6px 12px)" }}
                />
                <span className="text-[13px]">{s.title ?? s.url}</span>
              </a>
            ))}
          </div>
        </div>
      )}
      {costUsd !== null && <p className="text-xs text-muted-foreground">Estimated cost: {formatCostUsd(costUsd)}</p>}
      {error && <ActionError message={error} settingsLink={errorLink} />}
      {provenance}
    </>
  ) : (
    <>
      <div className="elev-sm flex flex-col items-center gap-3.5 rounded-[32px] bg-secondary px-6 py-12 text-center">
        <div className="size-11 rounded-full bg-accent-100" />
        <h3 className="m-0">{isWeek ? "This week's material isn't written yet" : "Today's lesson isn't written yet"}</h3>
        <p className="m-0 max-w-[38ch] text-muted-foreground">
          {readRows.length > 0
            ? `Written from the ${readRows.length === 1 ? "material" : `${readRows.length} materials`} in the list beside it, and citing only ${readRows.length === 1 ? "it" : "them"}. Generate it when you start.`
            : "Generate it now — Pensieve will pull in your sources and cite what it uses."}
        </p>
        <Button onClick={handleGenerate} disabled={isPending}>
          {isWeek ? "Generate this week's material" : "Generate today's lesson"}
        </Button>
        {error && <ActionError message={error} settingsLink={errorLink} />}
      </div>
      {provenance}
    </>
  );

  return (
    <div className="grid min-h-[calc(100vh-60px)] grid-cols-[minmax(0,1fr)_300px] max-[900px]:grid-cols-1">
      <div className="min-w-0 px-8 pt-6 pb-24 max-[640px]:px-4">
        <div className="flex max-w-[680px] flex-col gap-5 pl-[clamp(0px,6vw,96px)] max-[900px]:pl-0">
          {header}
          {main}
        </div>
      </div>

      <aside className="flex flex-col gap-5 border-l border-border bg-[color-mix(in_srgb,var(--secondary)_45%,var(--background))] px-6 pt-6 pb-10 max-[900px]:border-t max-[900px]:border-l-0">
        <section>
          <RailHeading>
            {isWeek ? "This week" : "Today"} · {formatDayTime(budgetMinutes)}
          </RailHeading>
          <div className="divide-y divide-border">
            <TodoRow on={ticked.has("lesson")} onToggle={() => toggle("lesson")}>
              Read the lesson
              <small className="block text-[12px] text-foreground/45">This page</small>
            </TodoRow>
            {readRows.map((r) => (
              <TodoRow key={r.key} on={ticked.has(r.key)} onToggle={() => toggle(r.key)} minutes={r.minutes}>
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{shortTitle(r.material.title)}</span>
                  <TierPill tier={r.tier} />
                </span>
                {partLabel(r) && <small className="block text-[12px] text-foreground/45">{partLabel(r)}</small>}
              </TodoRow>
            ))}
            {practiceRows.map((r) => (
              <TodoRow key={r.key} on={ticked.has(r.key)} onToggle={() => toggle(r.key)} minutes={r.minutes}>
                {r.label}
                <small className="block text-[12px] text-foreground/45">{r.task}</small>
              </TodoRow>
            ))}
          </div>
        </section>

        {isWeek && (
          <LogSessionForm nodeId={nodeId} budgetHours={budgetHours} sessions={sessions} onLogged={(hours) => setSessions((s) => [...s, { hours }])} />
        )}
        {content && (
          <MarkCompleteButton
            nodeId={nodeId}
            completed={completed}
            onDone={() => setCompleted(true)}
            label={`Mark ${unitLabel} complete`}
            className="h-10 w-full justify-center"
          />
        )}

        {content && content.citations.length > 0 && (
          <section>
            <RailHeading>Sources</RailHeading>
            <ul className="flex flex-col gap-1 text-[12.5px] leading-snug">
              {content.citations.map((c) => (
                <li key={c.url}>
                  <a href={c.url} target="_blank" rel="noreferrer" className="text-foreground/75 hover:text-accent-700 hover:underline">
                    {c.title}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(prev || next) && (
          <nav aria-label="Other days" className="mt-auto flex gap-2 max-[900px]:mt-0">
            {prev ? <DayLink link={prev} direction="prev" /> : <span className="flex-1" />}
            {next ? <DayLink link={next} direction="next" /> : <span className="flex-1" />}
          </nav>
        )}
        {content && (
          <Button variant="ghost" size="sm" className="justify-center" onClick={handleGenerate} disabled={isPending}>
            <RefreshCw />
            Rewrite this lesson
          </Button>
        )}
      </aside>
    </div>
  );
}

function DayLink({ link, direction }: { link: LeafLink; direction: "prev" | "next" }) {
  return (
    <Link href={link.href} className={cn("min-w-0 flex-1 rounded-[14px] bg-neutral-100 px-2.5 py-2 text-[12px] hover:bg-neutral-200", direction === "next" && "text-right")}>
      <small className="block text-[11px] text-foreground/45">{direction === "prev" ? `← ${link.label}` : `${link.label} →`}</small>
      <span className="line-clamp-2">{link.title}</span>
    </Link>
  );
}

/** "Where these come from": when the pages were opened and checked, and how the textbook was chosen. */
function WhereTheseComeFrom({ rows }: { rows: ReadRow[] }) {
  const checked = rows.filter((r) => r.material.verifiedAt);
  const unchecked = rows.length - checked.length;
  const latest = checked.map((r) => r.material.verifiedAt!).sort().at(-1);
  const backbone = rows.find((r) => r.material.backbone)?.material;
  const parts: string[] = [];
  if (latest) {
    const date = new Date(latest).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    parts.push(
      `Pensieve opened ${checked.length === rows.length ? (rows.length === 1 ? "this page" : "each page") : `${checked.length} of these pages`} on ${date} and checked ${checked.length === 1 ? "it is" : "each is"} what it claims to be.`,
    );
  }
  if (unchecked > 0) parts.push(`${unchecked === 1 ? "One is" : `${unchecked} are`} your own, listed as you gave ${unchecked === 1 ? "it" : "them"}.`);
  if (backbone && backbone.recommendedBy.length > 0) {
    parts.push(`The textbook was recommended by ${backbone.recommendedBy.length} independent source${backbone.recommendedBy.length === 1 ? "" : "s"}.`);
  }
  if (parts.length === 0) return null;
  return (
    <section aria-labelledby="src-h" className="flex flex-col gap-2 rounded-[28px] bg-foreground/4 px-[22px] py-[18px]">
      <h2 id="src-h" className="m-0 flex items-center gap-2 font-sans text-[13px] font-semibold">
        <ShieldCheck className="size-[15px] text-accent-2-700" strokeWidth={2.5} />
        Where these come from
      </h2>
      <p className="m-0 text-[12.5px] leading-normal text-neutral-800">{parts.join(" ")}</p>
    </section>
  );
}
