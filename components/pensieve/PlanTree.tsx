"use client";

import { BookOpen, ChevronDown, Code, FileText, FolderGit2, GraduationCap, PenLine, Video } from "lucide-react";
import { PRACTICE_REGISTRY, type PracticeFormat } from "@/lib/practice";
import { Menu } from "@base-ui/react/menu";
import { shortTitle } from "@/lib/shortTitle";
import { chapterAt, type Material, type PracticeCover, type PracticeItem } from "@/lib/schemas/material";
import { MAX_DAYS_PER_WEEK, type PlanNode } from "@/lib/planTree";
import { dayMinutes, formatDayTime } from "@/lib/studyTime";
import { cn } from "@/lib/utils";

/** Skeleton slots still expected under a parent while its children stream in. */
export interface PendingSlots {
  count: number;
  /** True when the slots are headings (single-column cards) rather than leaf chips. */
  groups: boolean;
}

/** "Arrays & Hashing – Two Pointers": the groups a run of a list's items spans, first to last; null when the run names none. */
function groupSpan(items: PracticeItem[], from: number, to: number): string | null {
  const groups = items.slice(from - 1, to).flatMap((i) => (i.group ? [i.group] : []));
  const first = groups[0];
  const last = groups[groups.length - 1];
  if (!first) return null;
  return first === last ? first : `${first} – ${last}`;
}

/** One line of a heading's Covers list: a material, what it is for here, and the part this unit takes. */
export interface CoverLine {
  key: string;
  m: Material;
  /** The practice format the line reserves; null for reading. */
  practice: PracticeFormat | null;
  part: string | null;
}

/**
 * A heading's reservation as lines, every one shown: the reading first, the backbone leading, one line per material and
 * activity with its chapters by number and title ("ch. 3 Storage and retrieval") or its note; then one line per
 * practice source with its format and the groups its run spans ("Problems · Arrays & Hashing – Two Pointers"), else
 * its note. A reservation whose material is not in the list has no line.
 */
export function coverLines(node: Pick<PlanNode, "covers" | "practiceCovers">, byId: ReadonlyMap<string, Material>): CoverLine[] {
  const reading = new Map<string, { m: Material; review: boolean; chapters: string[]; note: string | null }>();
  for (const r of node.covers ?? []) {
    const m = byId.get(r.id);
    if (!m) continue;
    const review = (r.activity ?? "read") === "review";
    const key = `${m.id}#${review ? "review" : "read"}`;
    const line = reading.get(key) ?? { m, review, chapters: [], note: null };
    const chapter = chapterAt(m.toc, r.chapter);
    if (chapter) line.chapters.push(`ch. ${chapter.n ?? r.chapter} ${chapter.title}`);
    else if (r.note) line.note = r.note;
    reading.set(key, line);
  }
  const read = [...reading]
    .sort(([, a], [, b]) => Number(b.m.backbone) - Number(a.m.backbone))
    .map(([key, { m, review, chapters, note }]): CoverLine => {
      const part = chapters.length > 0 ? chapters.join("; ") : note;
      return { key, m, practice: null, part: review ? `Review${part ? ` of ${part}` : ""}` : part };
    });
  const bySource = new Map<string, { m: Material; format: PracticeFormat; covers: PracticeCover[] }>();
  for (const c of node.practiceCovers ?? []) {
    const m = c.id === null ? undefined : byId.get(c.id);
    if (!m) continue;
    const key = `${c.format}#${m.id}`;
    bySource.set(key, { m, format: c.format, covers: [...(bySource.get(key)?.covers ?? []), c] });
  }
  const practice = [...bySource].map(([key, { m, format, covers }]): CoverLine => {
    const items = m.practice?.list?.items;
    const runs = covers.filter((c) => c.itemFrom && c.itemTo);
    let part: string | null;
    if (items && runs.length > 0) {
      const from = Math.min(...runs.map((c) => c.itemFrom!));
      const to = Math.max(...runs.map((c) => c.itemTo!));
      part = groupSpan(items, from, to) ?? `items ${from}–${to}`;
    } else part = covers.find((c) => c.note)?.note ?? null;
    return { key: `${key}#practice`, m, practice: format, part: [PRACTICE_REGISTRY[format].label, part].filter(Boolean).join(" · ") };
  });
  return [...read, ...practice];
}

function CoverIcon({ line }: { line: CoverLine }) {
  const className = "mt-px size-4 shrink-0 text-muted-foreground";
  if (line.practice) return line.practice === "problem-set" ? <Code className={className} /> : <PenLine className={className} />;
  switch (line.m.kind) {
    case "book":
      return <BookOpen className={className} />;
    case "video":
      return <Video className={className} />;
    case "course":
      return <GraduationCap className={className} />;
    case "repo":
      return <FolderGit2 className={className} />;
    default:
      return <FileText className={className} />;
  }
}

/** A heading's reservation as a list, one row per line with an icon for its kind; the backbone reads bold. */
export function CoversRow({ node, byId }: { node: PlanNode; byId: ReadonlyMap<string, Material> }) {
  const lines = coverLines(node, byId);
  if (lines.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col rounded-2xl bg-background px-3.5 py-1 text-[13px]">
      {lines.map((line, i) => (
        <li key={line.key} className={cn("flex min-w-0 items-start gap-2.5 py-1.5", i > 0 && "border-t border-foreground/8")}>
          <CoverIcon line={line} />
          <span className="min-w-0 flex-1 leading-snug">
            <span title={line.m.title} className={line.m.backbone ? "font-semibold" : undefined}>
              {shortTitle(line.m.title)}
            </span>
            {line.part && <span className="text-muted-foreground"> · {line.part}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const SPLIT_CHOICES = Array.from({ length: MAX_DAYS_PER_WEEK }, (_, i) => i + 1);

/**
 * "Split into [5 ▾] days". The words split the week into the learner's usual number of days; the number is a chip
 * that opens 1–7 days with the time each comes to, for a week that should have a different number.
 */
export function SplitControl({
  usual,
  hoursPerWeek,
  onSplit,
  disabled = false,
}: {
  usual: number;
  hoursPerWeek?: number;
  onSplit: (days: number) => void;
  disabled?: boolean;
}) {
  const words = "text-[11.5px] text-accent-700 underline underline-offset-2 hover:text-accent-800 disabled:pointer-events-none disabled:opacity-50";
  const perDay = (n: number) => (n === usual ? "usual" : hoursPerWeek === undefined ? null : `${formatDayTime(dayMinutes(hoursPerWeek, n))} a day`);
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" className={words} onClick={() => onSplit(usual)} disabled={disabled}>
        Split into
      </button>
      <Menu.Root>
        <Menu.Trigger
          disabled={disabled}
          aria-label={`Split into ${usual} days, or choose another number`}
          className="inline-flex h-[18px] items-center gap-0.5 rounded-full bg-accent-100 px-1.5 text-[11.5px] font-semibold text-accent-800 transition-colors hover:bg-accent-200 data-popup-open:bg-accent-200 data-disabled:pointer-events-none data-disabled:opacity-50"
        >
          {usual}
          <ChevronDown className="size-2.5 opacity-70" strokeWidth={3} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
            <Menu.Popup className="min-w-44 origin-(--transform-origin) rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95">
              {SPLIT_CHOICES.map((n) => (
                <Menu.Item
                  key={n}
                  label={`${n}`}
                  onClick={() => onSplit(n)}
                  className={cn(
                    "flex cursor-default items-center justify-between gap-4 rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none select-none data-highlighted:bg-accent-100",
                    n === usual && "font-semibold",
                  )}
                >
                  <span>
                    {n} day{n === 1 ? "" : "s"}
                  </span>
                  {perDay(n) && <span className="text-[11.5px] font-normal text-muted-foreground">{perDay(n)}</span>}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <button type="button" className={words} onClick={() => onSplit(usual)} disabled={disabled}>
        days
      </button>
    </span>
  );
}
