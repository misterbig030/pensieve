"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReadRow } from "@/components/pensieve/ReadTable";
import { DayLesson } from "@/components/pensieve/day/DayLesson";
import { LessonIntro } from "@/components/pensieve/day/LessonIntro";
import { TaskColumn } from "@/components/pensieve/day/TaskColumn";
import { useDayTicks } from "@/components/pensieve/day/useDayTicks";
import { ActionError } from "@/components/pensieve/leaf/ActionError";
import { LogSessionForm } from "@/components/pensieve/leaf/LogSessionForm";
import { MarkCompleteButton } from "@/components/pensieve/leaf/MarkCompleteButton";
import { LESSON_TASK, lessonMinutes, type DayTask } from "@/lib/dayTasks";
import { doneCount, toggleStep, toggleTask } from "@/lib/dayTicks";
import { formatCostUsd } from "@/lib/formatCost";
import { splitLesson, stepKey } from "@/lib/lessonSteps";
import { pushModelCalls } from "@/lib/modelCalls";
import { cn } from "@/lib/utils";
import { generateLeafContentAction } from "./actions";

interface Source {
  url: string;
  title: string | null;
}

/** A neighbouring day or week: where it goes, its label and its title. */
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
  initialContent: {
    contentMarkdown: string;
    citations: { title: string; url: string }[];
  } | null;
  youtubeSources: Source[];
  isCompleted: boolean;
  /** The leaf's Read table, for "Where these come from"; empty for plans saved before materials were assigned. */
  readRows: ReadRow[];
  /** What is assigned: the Read rows, then the Do rows. */
  tasks: DayTask[];
  prev: LeafLink | null;
  next: LeafLink | null;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-1.5 font-sans text-[11px] font-semibold tracking-[.04em] text-foreground/45 uppercase">
      {children}
    </h2>
  );
}

/** The day page: the day's tasks in a column that stays put, and beside it the lesson that walks through them. */
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
  tasks,
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
  const { ticks, set: setTicks } = useDayTicks(nodeId);

  const isWeek = unit === "week";

  // Each task's steps in the lesson, by tick key: a task with steps is done once they all are.
  const stepKeys = new Map<string, string[]>();
  for (const part of content ? splitLesson(content.contentMarkdown) : []) {
    if (part.kind !== "step" || !part.taskId) continue;
    stepKeys.set(part.taskId, [
      ...(stepKeys.get(part.taskId) ?? []),
      stepKey(part.taskId, part.nth),
    ]);
  }
  const stepKeysOf = (id: string) => stepKeys.get(id) ?? [];
  const taskIds = [
    ...tasks.map((t) => t.id),
    ...(content ? [LESSON_TASK] : []),
  ];
  const allDone =
    taskIds.length > 0 &&
    doneCount(taskIds, stepKeysOf, ticks) === taskIds.length;

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
        setContent({
          contentMarkdown: result.contentMarkdown,
          citations: result.citations,
        });
        setCostUsd(result.costUsd);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Generation failed. Try again.",
      );
    } finally {
      setIsPending(false);
    }
  }

  const provenance = readRows.length > 0 && (
    <WhereTheseComeFrom rows={readRows} />
  );

  const main = content ? (
    <>
      <DayLesson
        markdown={content.contentMarkdown}
        tasks={tasks}
        ticks={ticks}
        onToggleStep={(key, taskId) => setTicks(toggleStep(ticks, key, taskId, stepKeysOf(taskId)))}
        onRewrite={handleGenerate}
        rewriting={isPending}
      />
      {youtubeSources.length > 0 && (
        <div>
          <p className="mb-2.5 text-[11px] tracking-wide text-muted-foreground uppercase">
            Related video
          </p>
          <div className="flex flex-col gap-2">
            {youtubeSources.map((s) => (
              <a
                key={s.url}
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-3 rounded-2xl p-2 hover:bg-secondary"
              >
                <span
                  className="h-10 w-16 shrink-0 rounded-[10px]"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(135deg, var(--neutral-300) 0 6px, var(--neutral-200) 6px 12px)",
                  }}
                />
                <span className="text-[13px]">{s.title ?? s.url}</span>
              </a>
            ))}
          </div>
        </div>
      )}
      {content.citations.length > 0 && (
        <section>
          <SectionHeading>Sources</SectionHeading>
          <ul className="flex flex-col gap-1 text-[13px] leading-snug">
            {content.citations.map((c) => (
              <li key={c.url}>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground/75 hover:text-accent-700 hover:underline"
                >
                  {c.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleGenerate}
          disabled={isPending}
        >
          <RefreshCw />
          {isPending ? "Rewriting…" : "Rewrite this lesson"}
        </Button>
        {costUsd !== null && (
          <span className="text-xs text-muted-foreground">
            Estimated cost: {formatCostUsd(costUsd)}
          </span>
        )}
      </div>
      {error && <ActionError message={error} settingsLink={errorLink} />}
      {provenance}
    </>
  ) : (
    <>
      <LessonIntro
        unit={unit}
        tasks={tasks}
        pending={isPending}
        error={error}
        errorLink={errorLink}
        onWrite={handleGenerate}
      />
      {provenance}
    </>
  );

  return (
    <div className="grid min-h-[calc(100vh-60px)] grid-cols-[360px_minmax(0,1fr)] max-[900px]:grid-cols-1">
      {/* The top bar scrolls away, so the column sticks to the window's top and keeps the height it had under the bar. */}
      <aside
        aria-label={isWeek ? "This week's tasks" : "Today's tasks"}
        className="border-r border-border bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] max-[900px]:border-r-0 max-[900px]:border-b"
      >
        <div className="sticky top-0 flex h-[calc(100dvh-60px)] flex-col gap-3 overflow-y-auto pt-5 pr-[22px] pb-5 pl-8 max-[900px]:static max-[900px]:h-auto max-[900px]:px-4">
          <TaskColumn
            unit={unit}
            tasks={tasks}
            lessonMinutes={
              content ? lessonMinutes(content.contentMarkdown) : null
            }
            ticks={ticks}
            stepKeysOf={stepKeysOf}
            onToggleTask={(id) =>
              setTicks(toggleTask(ticks, id, stepKeysOf(id)))
            }
          >
            {isWeek && (
              <LogSessionForm
                nodeId={nodeId}
                budgetHours={budgetHours}
                sessions={sessions}
                onLogged={(hours) => setSessions((s) => [...s, { hours }])}
              />
            )}
            <MarkCompleteButton
              nodeId={nodeId}
              completed={completed}
              onDone={() => setCompleted(true)}
              label={`Mark ${unitLabel} complete`}
              variant={allDone ? "default" : "outline"}
              className="h-10 w-full justify-center"
            />
            {(prev || next) && (
              <nav aria-label="Other days" className="flex gap-2">
                {prev ? (
                  <DayLink link={prev} direction="prev" />
                ) : (
                  <span className="flex-1" />
                )}
                {next ? (
                  <DayLink link={next} direction="next" />
                ) : (
                  <span className="flex-1" />
                )}
              </nav>
            )}
          </TaskColumn>
        </div>
      </aside>

      <div className="min-w-0 px-10 pt-5 pb-24 max-[640px]:px-4">
        <div className="mx-auto flex max-w-[700px] flex-col gap-5">
          {header}
          {main}
        </div>
      </div>
    </div>
  );
}

function DayLink({
  link,
  direction,
}: {
  link: LeafLink;
  direction: "prev" | "next";
}) {
  return (
    <Link
      href={link.href}
      className={cn(
        "min-w-0 flex-1 rounded-[14px] bg-neutral-100 px-2.5 py-2 text-[12px] hover:bg-neutral-200",
        direction === "next" && "text-right",
      )}
    >
      <small className="block text-[11px] text-foreground/45">
        {direction === "prev" ? `← ${link.label}` : `${link.label} →`}
      </small>
      <span className="line-clamp-2">{link.title}</span>
    </Link>
  );
}

/** "Where these come from": when the pages were opened and checked, and how the textbook was chosen. */
function WhereTheseComeFrom({ rows }: { rows: ReadRow[] }) {
  const checked = rows.filter((r) => r.material.verifiedAt);
  const unchecked = rows.length - checked.length;
  const latest = checked
    .map((r) => r.material.verifiedAt!)
    .sort()
    .at(-1);
  const backbone = rows.find((r) => r.material.backbone)?.material;
  const parts: string[] = [];
  if (latest) {
    const date = new Date(latest).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    parts.push(
      `Pensieve opened ${checked.length === rows.length ? (rows.length === 1 ? "this page" : "each page") : `${checked.length} of these pages`} on ${date} and checked ${checked.length === 1 ? "it is" : "each is"} what it claims to be.`,
    );
  }
  if (unchecked > 0)
    parts.push(
      `${unchecked === 1 ? "One is" : `${unchecked} are`} your own, listed as you gave ${unchecked === 1 ? "it" : "them"}.`,
    );
  if (backbone && backbone.recommendedBy.length > 0) {
    parts.push(
      `The textbook was recommended by ${backbone.recommendedBy.length} independent source${backbone.recommendedBy.length === 1 ? "" : "s"}.`,
    );
  }
  if (parts.length === 0) return null;
  return (
    <section
      aria-labelledby="src-h"
      className="flex flex-col gap-2 rounded-[28px] bg-foreground/4 px-[22px] py-[18px]"
    >
      <h2
        id="src-h"
        className="m-0 flex items-center gap-2 font-sans text-[13px] font-semibold"
      >
        <ShieldCheck
          className="size-[15px] text-accent-2-700"
          strokeWidth={2.5}
        />
        Where these come from
      </h2>
      <p className="m-0 text-[12.5px] leading-normal text-neutral-800">
        {parts.join(" ")}
      </p>
    </section>
  );
}
