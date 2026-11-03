"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { KIND_ICON, byline, groupLabel, practiceTag } from "@/components/pensieve/MaterialsList";
import { isPracticeOnly } from "@/lib/materials";
import type { MaterialPlacement } from "@/lib/materialUses";
import { approxDuration } from "@/lib/researchProgress";
import { KIND_ORDER, type Material } from "@/lib/schemas/material";
import { cn } from "@/lib/utils";
import { checkedShort, columnTotals } from "./columnLines";

type Tone = "used" | "dim" | "plain";

interface Row {
  material: Material;
  /** The part the selected unit uses, or where the material comes in the plan. */
  note: string;
  tone: Tone;
}

const caption = "px-2 pt-2.5 pb-1 text-[10.5px] font-semibold tracking-[.05em] text-muted-foreground uppercase";

/** "Book", "Docs": a material's kind on its own. */
function kindName(m: Material): string {
  if (isPracticeOnly(m)) return "Practice";
  return m.kind.charAt(0).toUpperCase() + m.kind.slice(1);
}

/** "ch. 1–2 · Book · ≈ 4 h 10": the part or place first, the reason the column exists, then what it is and how big. */
function rowLine(m: Material, note: string): string {
  const size = m.minutes ? approxDuration(m.minutes) : m.practice ? practiceTag(m.practice) : null;
  return [note, m.backbone ? "Backbone" : kindName(m), size].filter(Boolean).join(" · ");
}

/** The whole list by kind, the backbone first, as the materials list groups it. */
function byKind(materials: Material[]): { label: string; items: Material[] }[] {
  const backbone = materials.find((m) => m.backbone) ?? null;
  const rest = materials.filter((m) => m !== backbone);
  const ordered = [...KIND_ORDER.flatMap((kind) => rest.filter((m) => m.kind === kind && !isPracticeOnly(m))), ...rest.filter(isPracticeOnly)];
  const groups: { label: string; items: Material[] }[] = backbone ? [{ label: "Backbone", items: [backbone] }] : [];
  for (const m of ordered) {
    const label = groupLabel(m);
    const last = groups.at(-1);
    if (last && last.label === label) last.items.push(m);
    else groups.push({ label, items: [m] });
  }
  return groups;
}

/**
 * The track's materials beside the plan. It opens on the unit selected in the outline: what that unit uses, with the
 * chapters or items, then the rest by where they come in the plan. "All" lists every material by kind. The page keys it
 * by the selected unit, so picking another unit starts it on that unit again.
 */
export function MaterialsColumn({ materials, unitLabel, placement }: { materials: Material[]; unitLabel: string; placement: MaterialPlacement }) {
  const hasUsed = placement.used.length > 0;
  const [view, setView] = useState<"unit" | "all">(hasUsed ? "unit" : "all");
  const [open, setOpen] = useState<string | null>(null);

  if (materials.length === 0) {
    return (
      <section aria-label="Materials" className="elev-sm rounded-[18px] bg-neutral-100 px-4 py-3.5 text-[13px] text-muted-foreground">
        This track has no materials.
      </section>
    );
  }

  const parts = new Map(placement.used.map((u) => [u.material.id, u.part]));
  const places = new Map([...placement.later, ...placement.earlier].map((p) => [p.material.id, p.place]));
  const groups: { label: string; rows: Row[] }[] =
    view === "unit"
      ? [
          { label: `Used in ${unitLabel}`, rows: placement.used.map((u) => ({ material: u.material, note: u.part, tone: "used" as const })) },
          {
            label: "Later in the plan",
            rows: [
              ...placement.later.map((p) => ({ material: p.material, note: p.place, tone: "dim" as const })),
              ...placement.unused.map((m) => ({ material: m, note: "Not in the plan yet", tone: "dim" as const })),
            ],
          },
          { label: "Earlier", rows: placement.earlier.map((p) => ({ material: p.material, note: p.place, tone: "dim" as const })) },
        ]
      : byKind(materials).map((g) => ({
          label: g.label,
          rows: g.items.map((m) => ({
            material: m,
            note: parts.get(m.id) ?? places.get(m.id) ?? "Not in the plan yet",
            tone: parts.has(m.id) ? ("used" as const) : ("plain" as const),
          })),
        }));

  return (
    <section aria-label="Materials" className="elev-sm flex max-h-[inherit] min-h-0 flex-col overflow-hidden rounded-[18px] bg-neutral-100">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-4 pt-3.5 pb-3">
        <h3 className="flex items-baseline gap-2">
          <span className="font-heading text-[17px] font-normal">Materials</span>
          <span className="text-[12px] text-muted-foreground">{materials.length}</span>
        </h3>
        <p className="m-0 text-[12px] text-muted-foreground">{columnTotals(materials)}</p>
        <p className="m-0 text-[12px] text-muted-foreground">{checkedShort(materials)}</p>
        <div role="group" aria-label="Show materials for" className="mt-1 flex gap-1.5">
          <Segment on={view === "unit"} disabled={!hasUsed} title={hasUsed ? undefined : `Nothing in ${unitLabel} uses a material yet`} onClick={() => setView("unit")}>
            {unitLabel}
          </Segment>
          <Segment on={view === "all"} onClick={() => setView("all")}>
            All
          </Segment>
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto px-2 pb-2.5">
        {groups
          .filter((g) => g.rows.length > 0)
          .map((g) => (
            <div key={g.label}>
              <h4 className={caption}>{g.label}</h4>
              <ul className="flex flex-col">
                {g.rows.map((row) => (
                  <MaterialRow key={row.material.id} row={row} open={open === row.material.id} onToggle={() => setOpen((id) => (id === row.material.id ? null : row.material.id))} />
                ))}
              </ul>
            </div>
          ))}
      </div>
    </section>
  );
}

function Segment({ on, disabled, title, onClick, children }: { on: boolean; disabled?: boolean; title?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 max-w-full items-center truncate rounded-full px-2.5 text-[11.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-50",
        on ? "bg-foreground text-background" : "bg-neutral-200 text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function MaterialRow({ row, open, onToggle }: { row: Row; open: boolean; onToggle: () => void }) {
  const m = row.material;
  const Icon = KIND_ICON[m.kind];
  const meta = byline(m);
  const linked = m.type !== "note" && m.type !== "file";
  return (
    <li
      className={cn(
        "rounded-[10px]",
        row.tone === "used" && "bg-accent-100 shadow-[inset_2px_0_0_var(--color-primary)]",
        row.tone === "dim" && !open && "opacity-60",
      )}
    >
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-start gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-neutral-200/60">
        <span className={cn("mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-[7px]", m.backbone ? "bg-accent-2-800 text-accent-2-100" : "bg-card")}>
          <Icon className="size-3.5" strokeWidth={2.25} />
        </span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[12.5px] font-semibold">{m.title}</b>
          <small className={cn("block text-[11px] text-muted-foreground", !open && "truncate")}>{rowLine(m, row.note)}</small>
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 px-2 pb-2.5 pl-[46px] text-[12px]">
          {meta && <span className="text-muted-foreground">{meta}</span>}
          {m.why && <p className="m-0 text-foreground/80">{m.why}</p>}
          {linked && (
            <a href={m.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start font-semibold text-primary hover:underline">
              Open <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}
    </li>
  );
}
