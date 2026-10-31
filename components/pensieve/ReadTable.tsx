import { budgetCeiling } from "@/lib/materials";
import { PRACTICE_REGISTRY, type PracticeFormat } from "@/lib/practice";
import { formatDuration } from "@/lib/researchProgress";
import { shortTitle } from "@/lib/shortTitle";
import { chapterAt, type Chapter, type Material, type MaterialRef, type MaterialTier, type PracticeCover, type PracticeItem, type PracticeRef, type RefActivity } from "@/lib/schemas/material";
import { cn } from "@/lib/utils";

export interface ReadRow {
  material: Material;
  tier: MaterialTier;
  minutes: number | null;
  /** The part: a chapter's sections, or the part of a resource without chapters. */
  note: string | null;
  /** The chapter this row reads, from the book's list; null for a whole resource. */
  chapter: Chapter | null;
  activity: RefActivity;
  /** Unique within a node: material id and chapter position. */
  key: string;
}

/** A practice row of a unit's Do table: what to do, how long, how it is finished, and where it comes from. */
export interface PracticeRow {
  format: PracticeFormat;
  /** The format's name on its pill: "Problems", "Recall". */
  label: string;
  task: string;
  /** How the learner knows it is finished; empty for a split week's reservation, which has none. */
  done: string;
  minutes: number;
  /** The source the row is from, or the reading a generated recall row was made from; null for a generated row. */
  material: Material | null;
  generated: boolean;
  /** The item of the source's list this row is, when it names one; null for any other practice row. */
  item: PracticeItem | null;
  /** 1-based position of the row's item in its source's list; null without one. */
  itemFrom: number | null;
  /** Unique within a node. */
  key: string;
}

const TIER_RANK: Record<MaterialTier, number> = { must: 0, should: 1 };

/** Must rows before should rows; a stable sort keeps the plan's own order within a tier. */
export function byTier(a: { tier: MaterialTier }, b: { tier: MaterialTier }): number {
  return TIER_RANK[a.tier] - TIER_RANK[b.tier];
}

/** A node's Read table rows, must first, skipping references to materials that are not in the list. */
export function readRowsFor(refs: MaterialRef[] | undefined, byId: ReadonlyMap<string, Material>): ReadRow[] {
  return (refs ?? [])
    .flatMap((r) => {
      const material = byId.get(r.id);
      return material
        ? [{ material, tier: r.tier, minutes: r.minutes, note: r.note, chapter: chapterAt(material.toc, r.chapter), activity: r.activity ?? "read", key: `${r.id}#${r.chapter ?? 0}` }]
        : [];
    })
    .sort(byTier);
}

/** A node's Do table rows in the plan's order, skipping rows whose source is not in the list. */
export function practiceRowsFor(refs: PracticeRef[] | undefined, byId: ReadonlyMap<string, Material>): PracticeRow[] {
  return (refs ?? []).flatMap((r, i) => {
    const material = r.id === null ? null : (byId.get(r.id) ?? null);
    if (r.id !== null && !material) return [];
    return [{ format: r.format, label: PRACTICE_REGISTRY[r.format].label, task: r.task, done: r.done, minutes: r.minutes, material, generated: r.generated, item: itemOf(r, material), itemFrom: r.itemFrom ?? null, key: `${r.format}#${r.id ?? "generated"}#${i}` }];
  });
}

/** The listed item a row is: one item by position in its source's list; null for a run, a row without a position, or past the list. */
function itemOf(r: Pick<PracticeRef, "itemFrom" | "itemTo">, material: Material | null): PracticeItem | null {
  if (!r.itemFrom || (r.itemTo ?? r.itemFrom) !== r.itemFrom) return null;
  return material?.practice?.list?.items[r.itemFrom - 1] ?? null;
}

/** "49. Group Anagrams", or the title alone for an item with no number. */
export function itemLabel(item: Pick<PracticeItem, "number" | "title">): string {
  return item.number ? `${item.number}. ${item.title}` : item.title;
}

/** A split week's kept practice reservations as Do rows. Only reservations that carry a task and minutes show; they have no done line. */
export function coverPracticeRows(covers: PracticeCover[] | undefined, byId: ReadonlyMap<string, Material>): PracticeRow[] {
  return practiceRowsFor(
    (covers ?? []).flatMap((c) =>
      // A cover keeps its row's id, so a generated recall row carries its reading's id: only a practice source of the
      // cover's own format is not generated, since a book can be reading and serve another format too.
      c.task && c.minutes ? [{ format: c.format, id: c.id, task: c.task, done: "", minutes: c.minutes, generated: c.id === null || byId.get(c.id)?.practice?.format !== c.format }] : [],
    ),
    byId,
  );
}

export function sumPracticeMinutes(rows: PracticeRow[]): number {
  return rows.reduce((t, r) => t + r.minutes, 0);
}

/** "Ch. 2 Understanding Foundation Models", or the title alone for an unnumbered chapter. */
export function chapterLabel(chapter: Pick<Chapter, "n" | "title">): string {
  return chapter.n !== null ? `Ch. ${chapter.n} ${chapter.title}` : chapter.title;
}

/** What a row reads, as a phrase after the title: "Ch. 2 …", "Review of Ch. 2 …", "Review"; null for a plain whole read. */
export function partLabel(row: Pick<ReadRow, "chapter" | "activity">): string | null {
  const review = row.activity === "review";
  if (row.chapter) return `${review ? "Review of " : ""}${chapterLabel(row.chapter)}`;
  return review ? "Review" : null;
}

const REVIEW_HINT = "A second pass over something an earlier unit read: recap, not new reading.";

/**
 * A row as a day card's subtitle, kept to one line: the chapter by number ("Ch. 1", "Review of ch. 2"; the title when the
 * chapter has no number, or for a resource without chapters), then the sections or part from the note.
 */
export function rowBrief(row: Pick<ReadRow, "material" | "chapter" | "activity" | "note">): { head: string; detail: string | null } {
  const review = row.activity === "review";
  const chapter = row.chapter;
  let head: string;
  if (chapter) head = `${review ? "Review of " : ""}${chapter.n !== null ? `${review ? "ch." : "Ch."} ${chapter.n}` : chapter.title}`;
  else head = review ? `Review of ${shortTitle(row.material.title)}` : shortTitle(row.material.title);
  return { head, detail: row.note };
}

/** Where a Read row links: the chapter's own page when it has one, else the material's page. */
export function rowHref(row: Pick<ReadRow, "material" | "chapter">): string {
  return row.chapter?.url ?? row.material.url;
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

/** A practice format's pill: TierPill's shape in the second accent. */
export function FormatPill({ label }: { label: string }) {
  return <span className="inline-flex justify-self-start rounded-full bg-accent-2-200 px-2 py-px text-[10.5px] font-semibold text-accent-2-800">{label}</span>;
}

const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * What a Do row asks for: its task, or for a row that is one item of a source's list the item as "49. Group Anagrams"
 * (linked to the item's page), a small solution link, and its group as a quiet label. `link` is off inside a link.
 */
export function PracticeTask({ row, link = true }: { row: PracticeRow; link?: boolean }) {
  const item = row.item;
  if (!item) return <>{row.task}</>;
  return (
    <>
      {item.url && link ? (
        <a href={item.url} {...EXTERNAL} onClick={(e) => e.stopPropagation()} className="hover:text-accent-700 hover:underline">
          {itemLabel(item)}
        </a>
      ) : (
        itemLabel(item)
      )}
      {item.solutionUrl && link && (
        <a href={item.solutionUrl} {...EXTERNAL} onClick={(e) => e.stopPropagation()} className="ml-1.5 text-[11px] font-normal text-muted-foreground underline underline-offset-2 hover:text-accent-700">
          solution
        </a>
      )}
      {item.group && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{item.group}</span>}
    </>
  );
}

/** Where a Do row comes from: its source, the reading a generated recall row was made from, or a Generated tag. */
export function PracticeSource({ row, link = true }: { row: PracticeRow; link?: boolean }) {
  if (!row.material) return <span>Generated</span>;
  return (
    <span>
      <ItemLink material={row.material} href={row.material.url} link={link} />
      {row.generated && " · from your reading"}
    </span>
  );
}

export function ItemLink({ material: m, href, className, link = true }: { material: Material; href: string; className?: string; link?: boolean }) {
  // The row names the material short; the tooltip keeps its full title.
  if (!link || m.type === "note" || m.type === "file") return <span className={className} title={m.title}>{shortTitle(m.title)}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" title={m.title} onClick={(e) => e.stopPropagation()} className={cn("hover:text-accent-700 hover:underline", className)}>
      {shortTitle(m.title)}
    </a>
  );
}

/**
 * A unit's budget as one line: reading and practice minutes against the budget. Without practice rows it reads
 * "3 h 11 of 6 h reading".
 */
export function budgetLine({ readingMinutes, practiceMinutes, budgetMinutes }: { readingMinutes: number; practiceMinutes: number; budgetMinutes: number }): string {
  if (practiceMinutes <= 0) return `${formatDuration(readingMinutes)} of ${formatDuration(budgetMinutes)} reading`;
  return `${formatDuration(readingMinutes)} reading · ${formatDuration(practiceMinutes)} practice · ${formatDuration(budgetMinutes)}`;
}

/**
 * How many minutes a unit runs past its budget, once past what the drafting checks accept (`budgetCeiling`); 0 within
 * it, so a unit the checks pass is not called over.
 */
export function minutesOver(totalMinutes: number, budgetMinutes: number): number {
  return totalMinutes > budgetCeiling(budgetMinutes) ? totalMinutes - budgetMinutes : 0;
}

/** Must and should minutes against the budget, as a two-part bar and one line of text, with how far it runs over. */
export function BudgetBar({ rows, practiceMinutes = 0, budgetMinutes, variant = "compact" }: { rows: ReadRow[]; practiceMinutes?: number; budgetMinutes: number; variant?: "compact" | "full" }) {
  const { must, should } = sumMinutes(rows);
  const budget = Math.max(budgetMinutes, 1);
  const line = budgetLine({ readingMinutes: must + should, practiceMinutes, budgetMinutes });
  const over = minutesOver(must + should + practiceMinutes, budgetMinutes);
  const share = (minutes: number, taken: number) => `${Math.min(100 - taken, (minutes / budget) * 100)}%`;
  const mustPct = Math.min(100, (must / budget) * 100);
  const shouldPct = Math.min(100 - mustPct, (should / budget) * 100);
  const bar = (
    <span className={cn("flex h-1.5 shrink-0 overflow-hidden rounded-full bg-neutral-300", variant === "full" ? "h-2 w-[220px] max-[640px]:w-full" : "w-40 max-[640px]:w-24")}>
      <span className="block bg-accent-700" style={{ width: `${mustPct}%` }} />
      <span className="block bg-neutral-400" style={{ width: `${shouldPct}%` }} />
      <span className="block bg-accent-2-500" style={{ width: share(practiceMinutes, mustPct + shouldPct) }} />
    </span>
  );
  if (variant === "full") {
    return (
      <div className="flex flex-wrap items-center gap-3.5 rounded-2xl bg-background px-3.5 py-3 text-[12.5px]">
        {bar}
        <span>
          <strong className="font-semibold">{formatDuration(must)}</strong> must · <strong className="font-semibold">{formatDuration(should)}</strong> should
          {practiceMinutes > 0 && (
            <>
              {" "}
              · <strong className="font-semibold">{formatDuration(practiceMinutes)}</strong> practice
            </>
          )}
        </span>
        <span className="ml-auto text-muted-foreground">
          {line}
          {over > 0 && <span className="text-accent-800"> · {formatDuration(over)} over</span>}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
      {bar}
      <span>
        {formatDuration(must)} must-read{should > 0 ? ` · ${formatDuration(should)} optional` : ""} · {line}
        {over > 0 && <span className="text-accent-800"> · {formatDuration(over)} over</span>}
      </span>
    </div>
  );
}

/** Compact Read rows for a planned unit in the plan view: tier, item and part, minutes. `link` is off inside a link. */
export function ReadRows({ rows, link = true }: { rows: ReadRow[]; link?: boolean }) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)_60px] items-center gap-x-2.5 gap-y-1.5 text-[12.5px]">
      {rows.map((r) => (
        <div key={r.key} className="contents">
          <TierPill tier={r.tier} />
          <span className="min-w-0 truncate">
            <ItemLink material={r.material} href={rowHref(r)} className="font-semibold" link={link} />
            {partLabel(r) && (
              <span className="text-muted-foreground" title={r.activity === "review" ? REVIEW_HINT : undefined}>
                {" "}
                · {partLabel(r)}
              </span>
            )}
            {r.note && <span className="text-muted-foreground"> · {r.note}</span>}
          </span>
          <span className="justify-self-end text-neutral-800">{r.minutes !== null ? `${r.minutes} min` : "—"}</span>
        </div>
      ))}
    </div>
  );
}

/** Compact Do rows for a planned unit in the plan view: format, task, minutes, and under it the done line and source. `link` is off inside a link. */
export function DoRows({ rows, link = true }: { rows: PracticeRow[]; link?: boolean }) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)_60px] items-start gap-x-2.5 gap-y-1.5 text-[12.5px]">
      {rows.map((r) => (
        <div key={r.key} className="contents">
          <FormatPill label={r.label} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-semibold" title={r.item ? itemLabel(r.item) : r.task}>
              <PracticeTask row={r} link={link} />
            </span>
            <span className="truncate text-[11.5px] text-muted-foreground" title={r.done || undefined}>
              <PracticeSource row={r} link={link} />
              {r.done && ` · ${r.done}`}
            </span>
          </span>
          <span className="justify-self-end text-neutral-800">{r.minutes} min</span>
        </div>
      ))}
    </div>
  );
}

/** The leaf page's Read table: Tier | Item | Min | Note, then a Do section for the unit's practice, with a budget footer. */
export function ReadTable({ rows, practice = [], budgetMinutes }: { rows: ReadRow[]; practice?: PracticeRow[]; budgetMinutes: number }) {
  return (
    <section aria-labelledby="read-h" className="flex flex-col gap-3 rounded-[28px] bg-secondary px-[22px] py-5">
      <div className="flex items-center gap-2.5">
        <h2 id="read-h" className="m-0 font-heading text-lg font-normal">
          {rows.length > 0 ? "Read" : "Do"}
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
              <tr key={r.key} className="border-t border-foreground/10 align-top">
                <td className="py-3 pr-2">
                  <TierPill tier={r.tier} />
                </td>
                <td className="px-2 py-3">
                  <div className="flex flex-col gap-0.5">
                    <span>
                      <ItemLink material={r.material} href={rowHref(r)} className="font-semibold" />
                      {r.material.backbone && (
                        <span className="ml-1.5 inline-flex rounded-full bg-accent-2-800 px-[7px] py-px align-[1px] text-[10px] font-semibold text-accent-2-100">BACKBONE</span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground" title={r.activity === "review" ? REVIEW_HINT : undefined}>
                      {[partLabel(r), r.material.author, r.material.kind, r.material.year].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                </td>
                <td className="px-2 py-3 text-right font-semibold">{r.minutes ?? "—"}</td>
                <td className="py-3 pl-3 leading-normal text-neutral-800">{r.note ?? ""}</td>
              </tr>
            ))}
            {rows.length > 0 && practice.length > 0 && (
              <tr className="border-t border-foreground/10">
                <th scope="colgroup" colSpan={4} className="pt-4 pb-1 text-left font-heading text-[15px] font-normal">
                  Do
                </th>
              </tr>
            )}
            {practice.map((r) => (
              <tr key={r.key} className="border-t border-foreground/10 align-top">
                <td className="py-3 pr-2">
                  <FormatPill label={r.label} />
                </td>
                <td className="px-2 py-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold">
                      <PracticeTask row={r} />
                    </span>
                    <span className="text-xs text-muted-foreground">
                      <PracticeSource row={r} />
                      {r.done && ` · ${r.done}`}
                    </span>
                  </div>
                </td>
                <td className="px-2 py-3 text-right font-semibold">{r.minutes}</td>
                <td className="py-3 pl-3" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <BudgetBar rows={rows} practiceMinutes={sumPracticeMinutes(practice)} budgetMinutes={budgetMinutes} variant="full" />
    </section>
  );
}
