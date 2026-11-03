import type { ReactNode } from "react";
import { BookOpen, Code, ExternalLink, Play } from "lucide-react";
import { FormatPill, PracticeSource, TierPill } from "@/components/pensieve/ReadTable";
import { taskHref, taskTitle, type DayTask } from "@/lib/dayTasks";
import { cn } from "@/lib/utils";
import { Tick } from "./Tick";

/** The "Read today's lesson" card, once there is a lesson. */
export interface LessonCard {
  kind: "lesson";
  minutes: number;
}

function TagPill({ children }: { children: ReactNode }) {
  return <span className="inline-flex rounded-full bg-accent-200 px-[7px] py-px text-[10.5px] font-semibold text-accent-800">{children}</span>;
}

/** A link out of the card, as a small pill; `soft` for the lesser one beside it. */
export function LinkPill({ href, soft, children }: { href: string; soft?: boolean; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex h-[26px] items-center gap-[5px] rounded-full px-2.5 text-[12px] font-semibold [&_svg]:size-[13px]",
        soft ? "border border-border text-muted-foreground hover:text-foreground" : "bg-card text-foreground hover:bg-neutral-200",
      )}
    >
      {children}
    </a>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Minutes({ minutes }: { minutes: number | null }) {
  return minutes ? <span className="ml-auto text-[12px] text-muted-foreground">{minutes} min</span> : null;
}

/** What a task card shows: its kind row, title, detail and links. */
function parts(task: DayTask | LessonCard, unit: "day" | "week") {
  if (task.kind === "lesson") {
    return {
      title: unit === "week" ? "Read this week's material" : "Read today's lesson",
      kind: (
        <>
          <TagPill>Lesson</TagPill>
          <Minutes minutes={task.minutes} />
        </>
      ),
      detail: null,
      links: null,
    };
  }
  const href = taskHref(task);
  if (task.kind === "read") {
    const { row } = task;
    const tag = row.activity === "review" ? "Review" : row.material.type === "youtube" ? "Video" : "Read";
    return {
      title: taskTitle(task),
      kind: (
        <>
          <TagPill>{tag}</TagPill>
          <TierPill tier={row.tier} />
          <Minutes minutes={row.minutes} />
        </>
      ),
      detail: row.note,
      links: href && (
        <LinkPill href={href}>
          {row.material.type === "youtube" ? <Play /> : <BookOpen />}
          {row.material.type === "youtube" ? "Watch" : row.chapter?.url ? "Open chapter" : "Open"}
        </LinkPill>
      ),
    };
  }
  const { row } = task;
  const meta = [row.item?.group, row.item?.difficulty && capitalize(row.item.difficulty)].filter(Boolean).join(" · ");
  return {
    title: taskTitle(task),
    kind: (
      <>
        <FormatPill label={row.label} />
        {meta && <span>{meta}</span>}
        <Minutes minutes={row.minutes} />
      </>
    ),
    detail: (
      <>
        {row.done && `${row.done} · `}
        <PracticeSource row={row} link={false} />
      </>
    ),
    links: (href || row.item?.solutionUrl) && (
      <>
        {href && (
          <LinkPill href={href}>
            {row.item ? <Code /> : <ExternalLink />}
            Open
          </LinkPill>
        )}
        {row.item?.solutionUrl && (
          <LinkPill href={row.item.solutionUrl} soft>
            Solution
          </LinkPill>
        )}
      </>
    ),
  };
}

/** One of the day's tasks in the task column: what it is, how long, how to open it, and its tick. */
export function TaskCard({ task, unit, ticked, onToggle }: { task: DayTask | LessonCard; unit: "day" | "week"; ticked: boolean; onToggle(): void }) {
  const { title, kind, detail, links } = parts(task, unit);
  return (
    <div
      data-done={ticked}
      className={cn("flex gap-[11px] rounded-[18px] px-3.5 py-3", ticked ? "bg-[color-mix(in_srgb,var(--neutral-100)_55%,transparent)]" : "elev-sm bg-neutral-100")}
    >
      <Tick on={ticked} label={title} onToggle={onToggle} className="mt-px self-start" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-[13px]">
        <div className="flex items-center gap-1.5 text-[11px] text-foreground/45">{kind}</div>
        <b className={cn("text-[14px] leading-[1.3] font-semibold", ticked && "text-muted-foreground line-through decoration-neutral-400")}>{title}</b>
        {detail && !ticked && <p className="m-0 text-[12.5px] leading-[1.45] text-muted-foreground">{detail}</p>}
        {links && <div className="mt-1 flex flex-wrap gap-1.5">{links}</div>}
      </div>
    </div>
  );
}
