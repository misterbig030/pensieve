import { Lock } from "lucide-react";
import {
  BudgetBar,
  FormatPill,
  PracticeTask,
  TierPill,
  itemLabel,
  partLabel,
  practiceRowsFor,
  practiceSourceLabel,
  readRowsFor,
  rowBrief,
  sumMinutes,
  sumPracticeMinutes,
  type PracticeRow,
  type ReadRow,
} from "@/components/pensieve/ReadTable";
import { isLocked, labelOf, type PlanNode } from "@/lib/planTree";
import { formatDuration } from "@/lib/researchProgress";
import { KIND_LABEL, type Material } from "@/lib/schemas/material";

/** The mock's `.rw` row: kind, text, time. On a narrow screen the kind sits above the text. */
const ROW = "grid grid-cols-[118px_minmax(0,1fr)_64px] items-baseline gap-x-2.5 gap-y-0.5 rounded-[10px] px-2.5 py-1.5 text-[13px] even:bg-foreground/[0.03] max-[900px]:grid-cols-[minmax(0,1fr)_auto]";
const KIND = "inline-flex items-center gap-1.5 text-[11px] font-semibold text-neutral-800 max-[900px]:col-span-full";
const TIME = "text-right text-xs text-muted-foreground";

function Caption({ children }: { children: string }) {
  return <h3 className="m-0 px-2.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{children}</h3>;
}

/** An open unit's Read section: one row per item, and the budget bar under them. */
export function ReadSection({ rows, budgetMinutes, practiceMinutes }: { rows: ReadRow[]; budgetMinutes: number; practiceMinutes: number }) {
  return (
    <section className="flex flex-col gap-1">
      <Caption>Read</Caption>
      <div className="flex flex-col">
        {rows.map((r) => {
          const part = partLabel(r);
          const detail = rowBrief(r).detail;
          return (
            <div key={r.key} className={ROW}>
              <span className={KIND}>
                {KIND_LABEL[r.material.kind]}
                <TierPill tier={r.tier} />
              </span>
              <span className="min-w-0">
                <span className="font-semibold" title={r.material.title}>
                  {r.material.title}
                </span>
                {part && <span className="text-muted-foreground"> · {part}</span>}
                {detail && <small className="mt-0.5 block text-xs text-muted-foreground">{detail}</small>}
              </span>
              <span className={TIME}>{r.minutes !== null ? formatDuration(r.minutes) : "—"}</span>
            </div>
          );
        })}
      </div>
      <div className="px-2.5 pt-1.5">
        <BudgetBar rows={rows} practiceMinutes={practiceMinutes} budgetMinutes={budgetMinutes} />
      </div>
    </section>
  );
}

/** An open unit's Practice section: the format, what to do (a listed item by number and title, with its group), the time. */
export function PracticeSection({ rows }: { rows: PracticeRow[] }) {
  return (
    <section className="flex flex-col gap-1">
      <Caption>Practice</Caption>
      <div className="flex flex-col">
        {rows.map((r) => (
          <div key={r.key} className={ROW}>
            <span className={KIND}>
              <FormatPill label={r.label} />
            </span>
            <span className="min-w-0">
              <span className="font-semibold" title={r.item ? itemLabel(r.item) : r.task}>
                <PracticeTask row={r} />
              </span>
              {!r.material && <small className="mt-0.5 block text-xs text-muted-foreground">{practiceSourceLabel(r)}</small>}
            </span>
            <span className={TIME}>{formatDuration(r.minutes)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** A week's days as cards: its label, one line per row, the day's time. A finished day is faded and tagged Done; the current day is Today. */
export function DayCards({ root, week, byId, lockBefore, currentLeafId }: { root: PlanNode; week: PlanNode; byId: ReadonlyMap<string, Material>; lockBefore: number; currentLeafId: string | null }) {
  return (
    <div className="grid grid-cols-1 gap-2">
      {(week.children ?? []).map((day) => {
        const locked = isLocked(day, lockBefore);
        const today = currentLeafId === day.id;
        const read = readRowsFor(day.materials, byId);
        const practice = practiceRowsFor(day.practice, byId);
        const minutes = sumMinutes(read).must + sumMinutes(read).should + sumPracticeMinutes(practice);
        const hasWork = read.length > 0 || practice.length > 0;
        return (
          <div
            key={day.id}
            className={`grid grid-cols-[60px_minmax(0,1fr)_60px] items-start gap-3 rounded-[14px] px-3 py-2.5 ${today ? "bg-accent-100 shadow-[inset_2px_0_0_var(--color-accent-700)]" : "bg-foreground/[0.04]"} ${locked ? "opacity-50" : ""}`}
          >
            <span className="flex flex-col items-start pt-px">
              <span className="font-heading text-xs text-accent-700">{labelOf(root, day)}</span>
              {locked && (
                <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-neutral-300 px-[7px] py-px text-[10px] font-bold text-neutral-800">
                  <Lock className="size-2.5" strokeWidth={2.75} aria-hidden />
                  Done
                </span>
              )}
              {today && <span className="mt-1 rounded-full bg-accent-700 px-[7px] py-px text-[10px] font-bold text-background">Today</span>}
            </span>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px]">
              {hasWork ? (
                <>
                  {read.map((r) => {
                    const brief = rowBrief(r);
                    return (
                      <li key={r.key} className="min-w-0">
                        <span className="text-neutral-800">{brief.head}</span>
                        {brief.detail && <span className="text-muted-foreground"> · {brief.detail}</span>}
                      </li>
                    );
                  })}
                  {practice.map((p) => (
                    <li key={p.key} className="min-w-0">
                      <span className="text-neutral-800">{p.label}</span> · <PracticeTask row={p} link={false} />
                    </li>
                  ))}
                </>
              ) : (
                <li className="text-muted-foreground">{day.summary || day.title}</li>
              )}
            </ul>
            <span className={TIME}>{hasWork ? formatDuration(minutes) : ""}</span>
          </div>
        );
      })}
    </div>
  );
}
