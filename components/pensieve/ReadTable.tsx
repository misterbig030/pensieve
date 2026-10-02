import { formatDuration } from "@/lib/researchProgress";
import type { Material, MaterialRef, MaterialTier } from "@/lib/schemas/material";
import { cn } from "@/lib/utils";

export interface ReadRow {
  material: Material;
  tier: MaterialTier;
  minutes: number | null;
  note: string | null;
}

/** A node's Read table rows, in order, skipping references to materials that are not in the list. */
export function readRowsFor(refs: MaterialRef[] | undefined, byId: ReadonlyMap<string, Material>): ReadRow[] {
  return (refs ?? []).flatMap((r) => {
    const material = byId.get(r.id);
    return material ? [{ material, tier: r.tier, minutes: r.minutes, note: r.note }] : [];
  });
}

export function sumMinutes(rows: ReadRow[]): { must: number; should: number } {
  return rows.reduce((t, r) => (r.tier === "must" ? { ...t, must: t.must + (r.minutes ?? 0) } : { ...t, should: t.should + (r.minutes ?? 0) }), { must: 0, should: 0 });
}

export function TierPill({ tier }: { tier: MaterialTier }) {
  return tier === "must" ? (
    <span className="inline-flex justify-self-start rounded-full bg-accent-700 px-2 py-px text-[10.5px] font-semibold text-background">Must</span>
  ) : (
    <span className="inline-flex justify-self-start rounded-full border border-neutral-600 px-[7px] py-px text-[10.5px] font-semibold text-neutral-800">Should</span>
  );
}

function ItemLink({ material: m, className, link = true }: { material: Material; className?: string; link?: boolean }) {
  if (!link || m.type === "note" || m.type === "file") return <span className={className}>{m.title}</span>;
  return (
    <a href={m.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={cn("hover:text-accent-700 hover:underline", className)}>
      {m.title}
    </a>
  );
}

/** Must and should minutes against the budget, as a two-part bar and one line of text. */
export function BudgetBar({ rows, budgetMinutes, variant = "compact" }: { rows: ReadRow[]; budgetMinutes: number; variant?: "compact" | "full" }) {
  const { must, should } = sumMinutes(rows);
  const budget = Math.max(budgetMinutes, 1);
  const left = Math.max(0, budgetMinutes - must - should);
  const over = must + should > budgetMinutes;
  const bar = (
    <span className={cn("flex h-1.5 shrink-0 overflow-hidden rounded-full bg-neutral-300", variant === "full" ? "h-2 w-[220px] max-[640px]:w-full" : "w-40 max-[640px]:w-24")}>
      <span className="block bg-accent-700" style={{ width: `${Math.min(100, (must / budget) * 100)}%` }} />
      <span className="block bg-neutral-400" style={{ width: `${Math.min(100 - Math.min(100, (must / budget) * 100), (should / budget) * 100)}%` }} />
    </span>
  );
  if (variant === "full") {
    return (
      <div className="flex flex-wrap items-center gap-3.5 rounded-2xl bg-background px-3.5 py-3 text-[12.5px]">
        {bar}
        <span>
          <strong className="font-semibold">{formatDuration(must)}</strong> must · <strong className="font-semibold">{formatDuration(should)}</strong> should · of {formatDuration(budgetMinutes)}
        </span>
        <span className={cn("ml-auto text-muted-foreground", over && "text-accent-800")}>
          {over ? `${formatDuration(must + should - budgetMinutes)} over the budget` : `Leaves ${formatDuration(left)} for the build`}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
      {bar}
      <span>
        {formatDuration(must)} must-read{should > 0 ? ` · ${formatDuration(should)} optional` : ""} · {over ? `${formatDuration(must + should - budgetMinutes)} over budget` : `${formatDuration(left)} left to build`}
      </span>
    </div>
  );
}

/** Compact Read rows for a planned unit in the plan view: tier, item and part, minutes. `link` is off inside a link. */
export function ReadRows({ rows, link = true }: { rows: ReadRow[]; link?: boolean }) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)_60px] items-center gap-x-2.5 gap-y-1.5 text-[12.5px]">
      {rows.map((r) => (
        <div key={r.material.id} className="contents">
          <TierPill tier={r.tier} />
          <span className="min-w-0 truncate">
            <ItemLink material={r.material} className="font-semibold" link={link} />
            {r.note && <span className="text-muted-foreground"> · {r.note}</span>}
          </span>
          <span className="justify-self-end text-neutral-800">{r.minutes !== null ? `${r.minutes} min` : "—"}</span>
        </div>
      ))}
    </div>
  );
}

/** The leaf page's Read table: Tier | Item | Min | Note, with a budget footer. */
export function ReadTable({ rows, budgetMinutes }: { rows: ReadRow[]; budgetMinutes: number }) {
  return (
    <section aria-labelledby="read-h" className="flex flex-col gap-3 rounded-[28px] bg-secondary px-[22px] py-5">
      <div className="flex items-center gap-2.5">
        <h2 id="read-h" className="m-0 font-heading text-lg font-normal">
          Read
        </h2>
        <span className="ml-auto text-[12.5px] text-muted-foreground">From the plan&apos;s materials list</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[11px] tracking-wide text-muted-foreground uppercase">
              <th scope="col" className="w-[72px] pt-1.5 pr-2 pb-2 font-medium">
                Tier
              </th>
              <th scope="col" className="px-2 pt-1.5 pb-2 font-medium">
                Item
              </th>
              <th scope="col" className="w-14 px-2 pt-1.5 pb-2 text-right font-medium">
                Min
              </th>
              <th scope="col" className="w-[38%] pt-1.5 pb-2 pl-3 font-medium">
                Note
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.material.id} className="border-t border-foreground/10 align-top">
                <td className="py-3 pr-2">
                  <TierPill tier={r.tier} />
                </td>
                <td className="px-2 py-3">
                  <div className="flex flex-col gap-0.5">
                    <span>
                      <ItemLink material={r.material} className="font-semibold" />
                      {r.material.backbone && (
                        <span className="ml-1.5 inline-flex rounded-full bg-accent-2-800 px-[7px] py-px align-[1px] text-[10px] font-semibold text-accent-2-100">BACKBONE</span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {[r.material.author, r.material.kind, r.material.year].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                </td>
                <td className="px-2 py-3 text-right font-semibold">{r.minutes ?? "—"}</td>
                <td className="py-3 pl-3 leading-normal text-neutral-800">{r.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <BudgetBar rows={rows} budgetMinutes={budgetMinutes} variant="full" />
    </section>
  );
}
