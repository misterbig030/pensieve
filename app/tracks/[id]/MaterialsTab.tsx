"use client";

import { Check } from "lucide-react";
import { MaterialsList, checkedLine, materialGroups, materialTotals } from "@/components/pensieve/MaterialsList";
import { approxDuration } from "@/lib/researchProgress";
import type { Material } from "@/lib/schemas/material";

const panel = "elev-sm flex flex-col gap-2.5 rounded-[18px] bg-neutral-100 px-4 py-3.5";
const caption = "text-[10.5px] font-semibold tracking-[.05em] text-muted-foreground uppercase";

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <b className="block font-heading text-[22px] font-normal">{value}</b>
      <small className="text-[11px] text-muted-foreground">{label}</small>
    </div>
  );
}

/** The track's materials: the whole list, and beside it how much there is, of what kind, and links to each group. */
export function MaterialsTab({ topic, materials }: { topic: string; materials: Material[] }) {
  const { readingMinutes, practiceMinutes } = materialTotals(materials);
  const groups = materialGroups(materials);
  const kinds = groups.filter((g) => g.label !== "Backbone");
  const most = Math.max(1, ...kinds.map((g) => g.count));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-8 max-[900px]:grid-cols-1">
      <div className="@container min-w-0">
        <MaterialsList bare topic={topic} materials={materials} initialShown={Infinity} />
      </div>
      <aside className="sticky top-0 flex flex-col gap-3.5 max-[900px]:static max-[900px]:order-first">
        <section className={panel}>
          <h4 className={caption}>{materials.length} materials</h4>
          <div className="flex gap-6">
            {readingMinutes > 0 && <Figure value={approxDuration(readingMinutes).replace("≈ ", "")} label="of reading" />}
            {practiceMinutes > 0 && <Figure value={approxDuration(practiceMinutes).replace("≈ ", "")} label="of practice" />}
          </div>
          <ul className="flex flex-col gap-1.5 text-[12.5px]">
            {kinds.map((g) => (
              <li key={g.anchor} className="flex items-center gap-2">
                <span className="w-16 shrink-0">{g.label}</span>
                <span className="h-[5px] flex-1 overflow-hidden rounded-full bg-neutral-200">
                  <span className="block h-full rounded-full bg-accent-500" style={{ width: `${(g.count / most) * 100}%` }} />
                </span>
                <span className="w-5 text-right text-muted-foreground">{g.count}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className={panel}>
          <h4 className={caption}>Checked</h4>
          <p className="m-0 flex items-start gap-1.5 text-[12.5px]">
            <Check className="mt-0.5 size-3.5 shrink-0 text-accent-2-700" strokeWidth={3} />
            {checkedLine(materials)}
          </p>
          <p className="m-0 text-[12px] text-muted-foreground">Sizes are for the part the plan uses. Each week assigns a slice; how much of it is required is the plan&apos;s call.</p>
        </section>
        <nav aria-label="Jump to a group" className={`${panel} max-[900px]:hidden`}>
          <h4 className={caption}>Jump to</h4>
          <ul className="flex flex-col gap-1 text-[12.5px]">
            {groups.map((g) => (
              <li key={g.anchor}>
                <a href={`#${g.anchor}`} className="flex items-center gap-2 rounded-md py-0.5 hover:text-primary">
                  {g.label}
                  {g.label !== "Backbone" && <span className="ml-auto text-muted-foreground">{g.count}</span>}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
    </div>
  );
}
