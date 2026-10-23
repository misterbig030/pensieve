import { learnerKind } from "@/lib/ai/research/verify";
import { budgetFor, cloneTree, daysInWeekOf, fullLabelOf, parentOf, walk, weeksOf, type Granularity, type PlanNode } from "@/lib/planTree";
import {
  PRACTICE_FORMATS,
  PRACTICE_REGISTRY,
  formatHours,
  formatRuns,
  isBlockFormat,
  itemMinutes,
  itemPositions,
  numberRuns,
  shareOut,
  weekBudgets,
  type PracticeFormat,
  type PracticePick,
} from "@/lib/practice";
import { activePicks, dayMinutes, isAllReading, readingShareOf, type PlanSplit } from "@/lib/studyTime";
import {
  normalizeCoverRef,
  normalizeMaterialRef,
  type CoverRef,
  type CoverRefDraft,
  type Material,
  type MaterialRef,
  type MaterialRefDraft,
  type PracticeCover,
  type PracticeCoverDraft,
  type PracticeRef,
  type PracticeRefDraft,
  type PracticeItem,
  clip,
  hostOf,
  shortId,
  type RefActivity,
  chapterAt,
} from "@/lib/schemas/material";
import type { SourceInput } from "@/lib/schemas/source";

/**
 * Prompts always call materials `M1…Mn` in list order, whatever their real ids are (short ids while drafting, uuids
 * once saved), so the model never has to echo a uuid. A book with a chapter list also gets one alias per chapter,
 * `M1.3` for the third chapter in its list. These map between the two.
 */
export interface ResolvedAlias {
  id: string;
  /** 1-based position in the material's chapter list; null for the whole resource. */
  chapter: number | null;
  /** 1-based position in a practice source's item list; set only by an item alias (`M4.12`), absent otherwise. */
  item?: number;
}

export interface MaterialAliases {
  /** `M1`, `M1.3` for a chapter (a number), `M4.12` for an item (`{ item: 12 }`). */
  alias(id: string, part?: number | null | { item: number }): string | undefined;
  resolve(alias: string): ResolvedAlias | undefined;
  /** How many chapters the material's list has; 0 without a list. */
  chapters(id: string): number;
  /** How many items the practice source's list has; 0 without a list. */
  items(id: string): number;
  /** The format a practice source serves; null for a material that is reading only. */
  practice(id: string): PracticeFormat | null;
  /** The item at a 1-based position of a practice source's list. */
  item(id: string, position: number): PracticeItem | undefined;
}

const ALIAS_RE = /^\[?\s*(m\d+)(?:\.(\d+))?\s*\]?$/i;

export function aliasMaterials(materials: Pick<Material, "id" | "toc" | "practice">[]): MaterialAliases {
  const toAlias = new Map<string, string>();
  const fromAlias = new Map<string, string>();
  const counts = new Map<string, number>();
  const itemCounts = new Map<string, number>();
  const lists = new Map<string, PracticeItem[]>();
  const formats = new Map<string, PracticeFormat>();
  materials.forEach((m, i) => {
    const alias = `M${i + 1}`;
    toAlias.set(m.id, alias);
    fromAlias.set(alias.toLowerCase(), m.id);
    counts.set(m.id, m.toc?.chapters.length ?? 0);
    itemCounts.set(m.id, m.practice?.list?.items.length ?? 0);
    if (m.practice?.list) lists.set(m.id, m.practice.list.items);
    if (m.practice) formats.set(m.id, m.practice.format);
  });
  return {
    alias: (id, part) => {
      const base = toAlias.get(id);
      if (base === undefined) return undefined;
      const n = typeof part === "object" && part !== null ? part.item : part;
      return n ? `${base}.${n}` : base;
    },
    resolve: (alias) => {
      const m = alias.match(ALIAS_RE);
      if (!m) return undefined;
      const id = fromAlias.get(m[1].toLowerCase());
      if (!id) return undefined;
      if (m[2] === undefined) return { id, chapter: null };
      // A suffix names a chapter of a book with a chapter list, or an item of a practice source with an item list.
      const n = Number(m[2]);
      if (n >= 1 && n <= (counts.get(id) ?? 0)) return { id, chapter: n };
      if (n >= 1 && n <= (itemCounts.get(id) ?? 0)) return { id, chapter: null, item: n };
      return undefined;
    },
    chapters: (id) => counts.get(id) ?? 0,
    items: (id) => itemCounts.get(id) ?? 0,
    practice: (id) => formats.get(id) ?? null,
    item: (id, position) => lists.get(id)?.[position - 1],
  };
}

/** One key per resource: `uuid#3` for a chapter, `uuid#0` for the whole. */
export function refKey(ref: { id: string; chapter?: number | null }): string {
  return `${ref.id}#${ref.chapter ?? 0}`;
}

/** "M1.1–M1.3, M2, M1.4": runs of consecutive chapters of one material collapse. */
export function formatAliases(refs: ResolvedAlias[], aliases: MaterialAliases): string {
  const runs: { id: string; first: number | null; last: number | null }[] = [];
  for (const ref of refs) {
    const prev = runs[runs.length - 1];
    if (prev && prev.id === ref.id && prev.last !== null && ref.chapter === prev.last + 1) prev.last = ref.chapter;
    else runs.push({ id: ref.id, first: ref.chapter, last: ref.chapter });
  }
  return runs
    .map((r) => {
      const first = aliases.alias(r.id, r.first);
      if (first === undefined) return null;
      return r.first !== null && r.last !== null && r.last > r.first ? `${first}–${aliases.alias(r.id, r.last)}` : first;
    })
    .filter((s): s is string => s !== null)
    .join(", ");
}

/** Resolves what the model wrote to real ids and chapters. Unknown ids are dropped and returned so the caller can report them. */
export function resolveMaterialRefs(
  refs: MaterialRefDraft[] | undefined,
  aliases: MaterialAliases,
): { refs: MaterialRef[]; unknown: string[] } {
  const out: MaterialRef[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const draft of refs ?? []) {
    const resolved = aliases.resolve(draft.id);
    // An item alias names a practice row's item, never a reading.
    if (!resolved || resolved.item !== undefined) {
      unknown.push(draft.id);
      continue;
    }
    if (seen.has(refKey(resolved))) continue;
    seen.add(refKey(resolved));
    out.push({ ...normalizeMaterialRef(draft), ...resolved });
  }
  return { refs: out, unknown };
}

export function resolveCoverRefs(refs: CoverRefDraft[] | undefined, aliases: MaterialAliases): { refs: CoverRef[]; unknown: string[] } {
  const out: CoverRef[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const draft of refs ?? []) {
    const resolved = aliases.resolve(draft.id);
    // An item alias names a practice row's item, never a reading.
    if (!resolved || resolved.item !== undefined) {
      unknown.push(draft.id);
      continue;
    }
    if (seen.has(refKey(resolved))) continue;
    seen.add(refKey(resolved));
    out.push({ ...normalizeCoverRef(draft), ...resolved });
  }
  return { refs: out, unknown };
}

/** The format the model wrote, if it is one the split picked. */
function pickedFormat(format: string, split: PlanSplit | null | undefined): PracticeFormat | null {
  const f = format.trim().toLowerCase();
  if (!(PRACTICE_FORMATS as readonly string[]).includes(f)) return null;
  return activePicks(split).some((p) => p.format === f) ? (f as PracticeFormat) : null;
}

/** "Problems "Arrays 1–6"": a refused row as the facts name it; an item row adds its alias, 'Problems M2.4 "Group Anagrams"'. */
function rowName(format: string, task: string, item?: string): string {
  const f = format.trim().toLowerCase();
  const label = (PRACTICE_FORMATS as readonly string[]).includes(f) ? PRACTICE_REGISTRY[f as PracticeFormat].label : format.trim();
  const t = task.trim();
  return `${label}${item ? ` ${item}` : ""} "${t.length > 60 ? `${t.slice(0, 59)}…` : t}"`;
}

/** "M2.4", "M2.15–M2.16, M2.20": positions of one list under its alias. */
export function itemAliases(base: string, positions: Iterable<number>): string {
  return numberRuns(positions)
    .map(([a, b]) => (a === b ? `${base}.${a}` : `${base}.${a}–${base}.${b}`))
    .join(", ");
}

/** "M2 items 1–9", "M2.7" for a run of one: a reservation's run as prompts and facts name it. */
export function itemRun(base: string, from: number, to: number): string {
  return from === to ? `${base}.${from}` : `${base} items ${from}–${to}`;
}

export interface ResolvePracticeOptions {
  /**
   * Keep a row or reservation of a listed source that names no item rather than refusing it as unknown. Revision asks
   * for it, then keeps only the ones its unit already had (a plan saved before item lists); the whole-tree checks
   * report those as facts.
   */
  keepUnitemized?: boolean;
}

/**
 * Resolves the model's practice rows. A row of a format the split did not pick is refused. A row naming a practice
 * source of its own format keeps it; one whose source serves another format is refused. A row with no id is one the
 * model wrote (`generated`), refused when its format is never written. Recall written from reading must name a
 * resource the unit itself reads (`reads`, its Read table's ids), whatever that resource's practice role, so a recall
 * row with no id, or citing other reading, is refused. An id not in the list is unknown; a reading id on any other
 * format is refused, since it is no practice source. A row of a source with an item list names one item (`M4.12`): it
 * keeps that position and takes the item's minutes; one naming the source without an item is unknown, as an item past
 * the list is.
 */
export function resolvePracticeRefs(
  drafts: PracticeRefDraft[] | undefined,
  aliases: MaterialAliases,
  split: PlanSplit | null | undefined,
  reads: readonly string[] = [],
  options: ResolvePracticeOptions = {},
): { refs: PracticeRef[]; unknown: string[]; refused: string[] } {
  const refs: PracticeRef[] = [];
  const unknown: string[] = [];
  const refused: string[] = [];
  for (const draft of drafts ?? []) {
    const name = rowName(draft.format, draft.task);
    const format = pickedFormat(draft.format, split);
    if (!format) {
      refused.push(`${name}: not one of the plan's picks`);
      continue;
    }
    const alias = draft.id?.trim();
    const resolved = alias ? aliases.resolve(alias) : undefined;
    const spec = PRACTICE_REGISTRY[format];
    const serves = resolved ? aliases.practice(resolved.id) : null;
    // A listed source's item, when the row is that source's own practice.
    const item = resolved && serves === format && resolved.item !== undefined ? aliases.item(resolved.id, resolved.item) : undefined;
    const task = clip(draft.task, 300) ?? (item ? clip(item.title, 300) : null);
    if (!task) {
      refused.push(`${name}: no task`);
      continue;
    }
    if (alias && !resolved) {
      unknown.push(alias);
      continue;
    }
    // Being on the unit's Read list is what makes a resource reading, so recall may be written from it whatever else it serves.
    const fromReading = format === "recall" && serves !== format && resolved !== undefined && reads.includes(resolved.id);
    if (serves !== null && serves !== format && !fromReading) {
      refused.push(`${name}: ${alias} serves ${PRACTICE_REGISTRY[serves].label}, not ${spec.label}`);
      continue;
    }
    const generated = serves !== format;
    if (generated) {
      const why =
        format === "recall"
          ? resolved && reads.includes(resolved.id)
            ? null
            : "not written from this unit's reading"
          : resolved
            ? `${alias} is not a practice source`
            : spec.generated === "never"
              ? "no source, and this format is never written"
              : null;
      if (why) {
        refused.push(`${name}: ${why}`);
        continue;
      }
    }
    // A listed source is done item by item: the source alone names no part of it.
    if (!generated && resolved && aliases.items(resolved.id) > 0 && !item && !options.keepUnitemized) {
      unknown.push(alias!);
      continue;
    }
    const minutes = item ? itemMinutes(format, item) : Number.isFinite(draft.minutes) ? Math.max(1, Math.min(600, Math.round(draft.minutes))) : 1;
    const position = item ? { itemFrom: resolved!.item!, itemTo: resolved!.item! } : {};
    refs.push({ format, id: resolved?.id ?? null, task, done: clip(draft.done, 300) ?? spec.doneWhen, minutes, generated, ...position });
  }
  return { refs, unknown, refused };
}

/**
 * Resolves a heading's practice reservations. One whose format is not a pick, or whose material is no practice source
 * of that format, is dropped into `unknown`. A source with an item list is reserved by a run of positions (`from`–`to`,
 * turned round when reversed, or an item alias for a run of one); a run past the list, or none, is unknown too. A source
 * without a list keeps its note and no positions.
 */
export function resolvePracticeCovers(
  drafts: PracticeCoverDraft[] | undefined,
  aliases: MaterialAliases,
  split: PlanSplit | null | undefined,
  options: ResolvePracticeOptions = {},
): { refs: PracticeCover[]; unknown: string[] } {
  const refs: PracticeCover[] = [];
  const unknown: string[] = [];
  for (const draft of drafts ?? []) {
    const resolved = aliases.resolve(draft.id);
    const format = pickedFormat(draft.format, split);
    if (!resolved || !format || aliases.practice(resolved.id) !== format) {
      unknown.push(draft.id);
      continue;
    }
    const cover: PracticeCover = { format, id: resolved.id, note: clip(draft.note, 300) };
    const size = aliases.items(resolved.id);
    if (size > 0) {
      const given = [draft.from, draft.to].filter((n): n is number => Number.isFinite(n)).map(Math.round);
      if (given.length === 0 && resolved.item !== undefined) given.push(resolved.item);
      if (given.length === 0) {
        if (options.keepUnitemized) refs.push(cover);
        else unknown.push(draft.id);
        continue;
      }
      const [from, to] = [Math.min(...given), Math.max(...given)];
      if (from < 1 || to > size) {
        const base = aliases.alias(resolved.id)!;
        unknown.push(`${base}.${from}–${base}.${to}`);
        continue;
      }
      cover.itemFrom = from;
      cover.itemTo = to;
    }
    refs.push(cover);
  }
  return { refs, unknown };
}

/** One picked format as the drafter sees it: the practice sources in the list that serve it, in list order. */
export interface PickSources {
  pick: PracticePick;
  sources: string[];
  /**
   * False when nothing can be assigned: no source, and the format is never written, or is written only from reading and
   * the list has none. Its time goes to reading.
   */
  assignable: boolean;
}

/** A source that is practice and nothing to read: it has a practice role and no reading time. */
export function isPracticeOnly(m: Pick<Material, "minutes" | "practice">): boolean {
  return !m.minutes && !!m.practice;
}

/** The split's picks with their sources. Empty when the plan is all reading. */
export function pickSources(split: PlanSplit | null | undefined, materials: Pick<Material, "id" | "practice" | "minutes">[]): PickSources[] {
  // A source that also serves as practice is still reading, so recall can be written from it.
  const hasReading = materials.some((m) => !isPracticeOnly(m));
  return activePicks(split).map((pick) => {
    const sources = materials.filter((m) => m.practice?.format === pick.format).map((m) => m.id);
    const rule = PRACTICE_REGISTRY[pick.format].generated;
    const writable = rule !== "never" && (rule !== "from-reading" || hasReading);
    return { pick, sources, assignable: sources.length > 0 || writable };
  });
}

/**
 * A week's budgets as the drafter is given them and the checks hold it to: `weekBudgets`, with the minutes of a pick
 * that can't be assigned moved to reading. Without picks nothing is practice and reading is the split's share of the
 * week (`MUST_SHARE` before the split is decided), so a split from before formats keeps its share.
 */
export function practiceBudgets(
  split: PlanSplit | null | undefined,
  weekMinutes: number,
  materials: Pick<Material, "id" | "practice" | "minutes">[],
): ReturnType<typeof weekBudgets> {
  if (activePicks(split).length === 0) {
    // All reading is all of the week, whatever share an all-reading pick shows.
    const share = split && isAllReading(split) ? 1 : (readingShareOf(split) ?? MUST_SHARE);
    return { reading: Math.round(weekMinutes * share), practice: {} };
  }
  const budgets = weekBudgets(split, weekMinutes);
  for (const { pick, assignable } of pickSources(split, materials)) {
    if (assignable) continue;
    budgets.reading += budgets.practice[pick.format] ?? 0;
    delete budgets.practice[pick.format];
  }
  return budgets;
}

/** A pick on the time card: its hours, or none with `toReading` when it can't be assigned and its time is reading. */
export type PickHours = ReturnType<typeof formatHours>[number] & { toReading: boolean };

/**
 * The time card's hours: reading, and each pick's (`formatHours`). A pick that can't be assigned is drafted as reading
 * (`practiceBudgets`), so its hours count as reading and it has none of its own.
 */
export function splitHours(split: PlanSplit, totalHours: number, materials: Pick<Material, "id" | "practice" | "minutes">[]): { reading: number; picks: PickHours[] } {
  const assignable = new Map(pickSources(split, materials).map((p) => [p.pick.format, p.assignable]));
  let reading = Math.round((totalHours * split.readingShare) / 100);
  const picks = formatHours(split, totalHours).map((p) => {
    const toReading = assignable.get(p.format) === false;
    if (toReading) reading += p.hours;
    return { ...p, hours: toReading ? 0 : p.hours, toReading };
  });
  return { reading, picks };
}

/**
 * The split as drafting spends it: a pick that can't be assigned is reading (`practiceBudgets`), so its share of the
 * practice time moves to the reading share and the other picks keep their proportions. All reading when none is left.
 */
export function draftedSplit(split: PlanSplit, materials: Pick<Material, "id" | "practice" | "minutes">[]): PlanSplit {
  const picks = pickSources(split, materials);
  const kept = picks.filter((p) => p.assignable).map((p) => p.pick);
  if (kept.length === picks.length) return split;
  const keptShare = kept.reduce((sum, p) => sum + p.share, 0);
  if (kept.length === 0) return { ...split, readingShare: 100, formats: [] };
  const readingShare = Math.round(split.readingShare + ((100 - split.readingShare) * (100 - keptShare)) / 100);
  const shares = kept.map((p) => Math.round((p.share / keptShare) * 100));
  const largest = shares.indexOf(Math.max(...shares));
  shares[largest] += 100 - shares.reduce((sum, n) => sum + n, 0);
  return { ...split, readingShare, formats: kept.map((p, i) => ({ ...p, share: shares[i] })) };
}

/**
 * Each picked block format's minutes over the whole plan of `planMinutes`: its share of the plan's practice, shared as
 * a week's is (`practiceBudgets`). A block comes whole, so it is budgeted over the plan rather than per week.
 */
export function planBlockBudgets(
  split: PlanSplit | null | undefined,
  planMinutes: number,
  materials: Pick<Material, "id" | "practice" | "minutes">[],
): Partial<Record<PracticeFormat, number>> {
  const { practice } = practiceBudgets(split, planMinutes, materials);
  return Object.fromEntries(PRACTICE_FORMATS.filter((f) => isBlockFormat(f) && practice[f] !== undefined).map((f) => [f, practice[f]!]));
}

/** The minutes of `format`'s practice rows in the tree's leaves that end by study day `through`. */
export function placedMinutes(root: PlanNode, format: PracticeFormat, through: number): number {
  let minutes = 0;
  walk(root, (n) => {
    if ((n.children?.length ?? 0) > 0 || n.end > through) return;
    for (const r of n.practice ?? []) if (r.format === format) minutes += r.minutes;
  });
  return minutes;
}

/** One fact per pick that can't be assigned, for the drafting call's facts. */
export function noSourceFacts(split: PlanSplit | null | undefined, materials: Pick<Material, "id" | "practice" | "minutes">[]): string[] {
  return pickSources(split, materials)
    .filter((p) => !p.assignable)
    .map((p) => `no source for ${PRACTICE_REGISTRY[p.pick.format].label}: its time goes to reading`);
}

/** Chapter numbers a note names: "Ch. 4 §2" → [4], "ch. 5–6" → [5, 6], "chapters 3, 7 and 9" → [3, 7, 9]. */
export function parseChapters(note: string | null | undefined): number[] {
  if (!note) return [];
  const out: number[] = [];
  for (const m of note.matchAll(/\b(?:ch(?:apters?|s)?\.?|chap\.?)\s*((?:\d+\s*(?:[-–—]|to|,|and|&)?\s*)+)/gi)) {
    const body = m[1];
    for (const part of body.split(/\s*(?:,|and|&)\s*/)) {
      const range = part.match(/(\d+)\s*(?:[-–—]|to)\s*(\d+)/);
      if (range) {
        const [a, b] = [Number(range[1]), Number(range[2])];
        if (b >= a && b - a < 60) for (let c = a; c <= b; c++) out.push(c);
        continue;
      }
      const single = part.match(/(\d+)/);
      if (single) out.push(Number(single[1]));
    }
  }
  return [...new Set(out)];
}

export function tierMinutes(refs: MaterialRef[] | undefined): { must: number; should: number } {
  let must = 0;
  let should = 0;
  for (const r of refs ?? []) {
    if (r.tier === "must") must += r.minutes ?? 0;
    else should += r.minutes ?? 0;
  }
  return { must, should };
}

/**
 * The leaf's time budget in minutes: a week leaf's hours, or a day's share of the learner's weekly hours over the
 * `daysInWeek` days of its week (about an hour when the hours are not known).
 */
export function budgetMinutes(node: Pick<PlanNode, "level" | "budgetHours">, hoursPerWeek?: number, daysInWeek?: number): number {
  if (node.budgetHours !== null) return node.budgetHours * 60;
  if (node.level !== "day") return 0;
  return hoursPerWeek === undefined ? 60 : dayMinutes(hoursPerWeek, daysInWeek);
}

/** The share of a leaf's budget its `must` reading should take: the rest is building. */
export const MUST_SHARE = 0.6;

interface ChapterStep {
  label: string;
  chapters: number[];
}

/** "ch. 3 after ch. 5 (Week 4)" for each place the backbone goes backwards. */
export function chapterRegressions(steps: ChapterStep[]): string[] {
  const out: string[] = [];
  let furthest = 0;
  for (const step of steps) {
    if (step.chapters.length === 0) continue;
    const first = Math.min(...step.chapters);
    if (first < furthest) out.push(`backbone ch. ${first} after ch. ${furthest} (${step.label})`);
    furthest = Math.max(furthest, ...step.chapters);
  }
  return out;
}

/**
 * Chapters up to the last reserved one that no heading reserves: of the backbone's own chapters when its list is known
 * (`listed`, which after an allocation holds only the kept ones), else every number from 1.
 */
export function chapterGaps(reserved: number[], listed?: number[]): number[] {
  if (reserved.length === 0) return [];
  const have = new Set(reserved);
  const last = Math.max(...reserved);
  const candidates = listed ?? Array.from({ length: last }, (_, i) => i + 1);
  return [...new Set(candidates)].filter((c) => c <= last && !have.has(c)).sort((a, b) => a - b);
}

/** The backbone's chapter numbers as the checks name them: each chapter's own number, else its position. */
function listedChapters(toc: CheckMaterial["toc"]): number[] | undefined {
  return toc?.chapters.map((c, i) => c.n ?? i + 1);
}

function formatChapters(chapters: number[]): string {
  return chapters.length > 6 ? `${chapters.slice(0, 6).join(", ")}, …` : chapters.join(", ");
}

/**
 * `practice-outside`: a sourced practice row of a format the parent reserved, from a source it did not reserve; one from
 * a source some heading reserves when its parent reserved none of it; an item outside the parent's run of that source;
 * and a heading's run outside its parent's.
 * `practice-overlap`: an item another unit already did, or one two units of a level take; a run two headings reserve.
 * `practice-generated`: a row the model wrote where the registry forbids it (a format never written, or recall not from
 * the unit's own reading).
 */
export type BreachKind =
  | "outside"
  | "overlap"
  | "whole-book"
  | "review-before-read"
  | "over-budget"
  | "unread-reservation"
  | "practice-outside"
  | "practice-overlap"
  | "practice-generated";

/** The breaches a drop can cure: the row goes, the unit keeps the rest. Over-budget and unread reservations stay facts. */
export const DROPPABLE: ReadonlySet<BreachKind> = new Set<BreachKind>(["outside", "overlap", "whole-book", "review-before-read", "practice-outside", "practice-overlap", "practice-generated"]);

export interface Breach {
  kind: BreachKind;
  /** Position among the checked units; -1 for the parent's (its unread reservation, or its week's budget). */
  index: number;
  /** "Week 1" */
  unit: string;
  refs: ResolvedAlias[];
  /** `refs` as the prompt names them: "M1.3–M1.4"; for a practice breach, its row: 'Problems "Arrays 1–6"'. */
  names: string;
  /** The sentence the retry quotes and the admin dock shows. */
  text: string;
  /** The practice rows a practice breach names, which a drop removes: one row each. */
  practice?: (Pick<PracticeRef, "format" | "id" | "task"> & { itemFrom?: number | null })[];
  /** The practice reservations a practice breach names, which a drop removes: one each. */
  practiceCovers?: Pick<PracticeCover, "format" | "id" | "itemFrom" | "itemTo">[];
}

export interface LevelChecks {
  facts: string[];
  breaches: Breach[];
}

type CheckMaterial = Pick<Material, "id" | "toc" | "minutes" | "practice"> & { backbone?: boolean; kind?: Material["kind"] };

export interface LevelCheckInput {
  root: PlanNode;
  /** The units this level placed, in order, already in `root`. */
  nodes: PlanNode[];
  leaves: boolean;
  /** Whether these are the plan's top-level units. */
  top: boolean;
  /** The plan's materials, in list order, for aliases, chapter lists and sizes. */
  materials: CheckMaterial[];
  unknownIds: string[];
  /** The learner's weekly hours. With them, day leaves are checked against a day's share of the week. */
  hoursPerWeek?: number;
  /** The learner's usual study days a week, for weeks and months not planned yet. */
  daysPerWeek: number;
  /**
   * The plan's split: its reading share and the picks a week's practice is budgeted by (`practiceBudgets`). Without
   * one, `MUST_SHARE` stands in for the reading share.
   */
  split?: PlanSplit | null;
  /**
   * Which practice rows and reservations were saved before this call (revision's whole-tree checks): for those, the
   * rules on item lists and on reserved sources state facts and never breaches, so a saved row is never dropped for
   * them. Rows a call adds or changes are held to the rules as drafted ones are. Left out, nothing is saved.
   */
  saved?: (node: PlanNode, row: PracticeRef | PracticeCover) => boolean;
}

/**
 * One practice row or reservation of one unit, as revision compares it with the saved tree: unit, row or reservation,
 * format, source, item positions and task. Minutes, done and note are left out: the model's changes to them do not make
 * a row new.
 */
export function practiceRowKey(nodeId: string, r: PracticeRef | PracticeCover): string {
  return JSON.stringify([nodeId, "done" in r ? "row" : "cover", r.format, r.id, r.itemFrom ?? null, r.itemTo ?? null, r.task ?? null]);
}

/** The practice rows and reservations a saved tree holds, by `practiceRowKey`. */
export function savedPracticeRows(root: PlanNode): (node: PlanNode, row: PracticeRef | PracticeCover) => boolean {
  const keys = new Set<string>();
  walk(root, (n) => {
    for (const r of [...(n.practice ?? []), ...(n.practiceCovers ?? [])]) keys.add(practiceRowKey(n.id, r));
  });
  return (node, row) => keys.has(practiceRowKey(node.id, row));
}

/** How far must-reading may run past the plan's reading share before it is worth reporting. */
export const SHARE_TOLERANCE = 1.25;

/** Minutes a leaf's total or part may run past its tolerance too, so a short budget is not held to the minute. */
export const BUDGET_SLACK = 10;

/** The most a leaf's budget of `minutes`, or one part of it, holds before the checks call it over. */
export function budgetCeiling(minutes: number): number {
  return minutes * SHARE_TOLERANCE + BUDGET_SLACK;
}

type RefLike = { id: string; chapter?: number | null; activity?: RefActivity; note?: string | null };

const isRead = (r: RefLike) => (r.activity ?? "read") === "read";
const toResolved = (r: RefLike): ResolvedAlias => ({ id: r.id, chapter: r.chapter ?? null });
/** A node's references: a heading's reservation or a leaf's Read table. */
const refsOf = (n: PlanNode): RefLike[] => [...(n.covers ?? []), ...(n.materials ?? [])];

/**
 * The checks in code that run after each drafted level. Facts describe the level for the admin panel and the eval;
 * breaches are rule violations the drafter is asked to correct, and the droppable ones are removed when it does not.
 * Reading and practice are budgeted over a week: a week leaf on its own, or a week's days together (days at the top
 * of a one-week plan are one week). A single day is held only to its own total, so a day may be all reading or all
 * practice.
 */
export function levelChecks(input: LevelCheckInput): LevelChecks {
  const facts: string[] = [];
  const breaches: Breach[] = [];
  if (input.unknownIds.length > 0) facts.push(`dropped unknown ${[...new Set(input.unknownIds)].join(", ")}`);
  if (input.nodes.length === 0) return { facts, breaches };

  const label = (n: PlanNode) => fullLabelOf(input.root, n);
  const aliases = aliasMaterials(input.materials);
  const byId = new Map(input.materials.map((m) => [m.id, m]));
  const listed = (id: string) => (byId.get(id)?.toc?.chapters.length ?? 0) > 0;
  // A book without a list is divided by topic in notes, so several units hold it; it is never anyone's to take.
  const byTopic = (r: RefLike) => !r.chapter && !listed(r.id) && byId.get(r.id)?.kind === "book";
  // A row saved before chapters were data: the whole book, with the chapters in its note. It stands as written.
  const legacy = (r: RefLike) => !r.chapter && listed(r.id) && parseChapters(r.note).length > 0;
  /** The minutes a reservation is known to take: a chapter's size, a legacy note's chapters, a sized whole resource. */
  const knownMinutes = (r: RefLike): number => {
    const m = byId.get(r.id);
    if (r.chapter) return chapterAt(m?.toc, r.chapter)?.minutes ?? 0;
    if (byTopic(r)) return 0;
    if (legacy(r)) return parseChapters(r.note).reduce((sum, n) => sum + (m?.toc?.chapters.find((c) => c.n === n)?.minutes ?? 0), 0);
    if (listed(r.id)) return 0;
    return m?.minutes ?? 0;
  };
  // As drafted: a pick with no source is reading here too, as the leaves' budgets have it (`practiceBudgets`), and an
  // all-reading pick is all of the time whatever share it shows.
  const drafted = input.split ? draftedSplit(input.split, input.materials) : null;
  const share = drafted && isAllReading(drafted) ? 1 : (readingShareOf(drafted) ?? MUST_SHARE);
  const leafBudget = (node: PlanNode) => budgetMinutes(node, input.hoursPerWeek, daysInWeekOf(input.root, node, input.daysPerWeek));
  const verb = input.leaves ? "reads" : "reserves";
  const names = (refs: RefLike[]) => formatAliases(refs.map(toResolved), aliases);
  const breach = (kind: BreachKind, index: number, unit: string, refs: RefLike[], text: string) => breaches.push({ kind, index, unit, refs: refs.map(toResolved), names: names(refs), text });
  /** 'Problems M2.4 "Group Anagrams"' for an item row, 'Problems "Arrays 1–6"' otherwise. */
  const rowLabel = (row: PracticeRef) => rowName(row.format, row.task, row.id !== null && row.itemFrom ? aliases.alias(row.id, { item: row.itemFrom }) : undefined);
  /** "Problems M2 items 1–9" for a run, "Problems M3" for a source without one. Sourced reservations only. */
  const coverLabel = (c: PracticeCover) => {
    const base = aliases.alias(c.id!) ?? c.id!;
    return `${PRACTICE_REGISTRY[c.format].label} ${c.itemFrom && c.itemTo ? itemRun(base, c.itemFrom, c.itemTo) : base}`;
  };
  const rowBreach = (kind: BreachKind, index: number, unit: string, row: PracticeRef, text: string): Breach => ({
    kind,
    index,
    unit,
    refs: [],
    names: rowLabel(row),
    text,
    practice: [{ format: row.format, id: row.id, task: row.task, itemFrom: row.itemFrom ?? null }],
  });
  const coverBreach = (kind: BreachKind, index: number, unit: string, c: PracticeCover, text: string): Breach => ({
    kind,
    index,
    unit,
    refs: [],
    names: coverLabel(c),
    text,
    practiceCovers: [{ format: c.format, id: c.id, itemFrom: c.itemFrom ?? null, itemTo: c.itemTo ?? null }],
  });
  const practiceBreach = (kind: BreachKind, index: number, unit: string, row: PracticeRef, text: string) => breaches.push(rowBreach(kind, index, unit, row, text));
  // The rules on item lists and on reserved sources hold what this call drafts; over saved rows they are facts.
  const newRule = (b: Breach, node: PlanNode, row: PracticeRef | PracticeCover) => (input.saved?.(node, row) ? facts.push(b.text) : breaches.push(b));

  // Where these units sit: their parent (none at the top level), its line of ancestors, and their own descendants.
  const placed = new Set(input.nodes.map((n) => n.id));
  const parent = parentOf(input.root, input.nodes[0].id);
  const parentNode = parent && parent.id !== input.root.id ? parent : null;
  const skip = new Set<string>(placed);
  for (let p = parent; p; p = parentOf(input.root, p.id)) skip.add(p.id);
  for (const n of input.nodes) walk(n, (d) => void skip.add(d.id));

  // The parent's reservation: chapter keys, plus whole reservations that admit any chapter of that resource.
  const reservedKeys = new Set<string>();
  const reservedWhole = new Set<string>();
  for (const r of (parentNode?.covers ?? []).filter(isRead)) {
    if (r.chapter) reservedKeys.add(refKey(r));
    else reservedWhole.add(r.id);
  }
  // A reservation of any kind binds the children's reads; a review cover reserves nothing for reading.
  const hasReservation = (parentNode?.covers?.length ?? 0) > 0;
  const inReservation = (r: RefLike) => reservedKeys.has(refKey(r)) || reservedWhole.has(r.id);

  // What every other unit in the plan reads or reserves, keyed to the unit that holds it. What the parent reserved is
  // left out: its own level already settled who shares it (consecutive units may share a resource too long for one),
  // so the children may read it whatever a sibling of the parent also holds.
  const taken = new Map<string, string>();
  walk(input.root, (n) => {
    if (n.id === input.root.id || skip.has(n.id)) return;
    for (const r of refsOf(n).filter(isRead)) if (!byTopic(r) && !inReservation(r) && !taken.has(refKey(r))) taken.set(refKey(r), label(n));
  });
  // Siblings: a heading holds a resource exclusively; consecutive leaves may share one that is too long for one of them.
  const siblingLast = new Map<string, number>();
  const sizeOf = (r: RefLike): number | null => (r.chapter ? (chapterAt(byId.get(r.id)?.toc, r.chapter)?.minutes ?? null) : (byId.get(r.id)?.minutes ?? null));
  const mayShare = (node: PlanNode, r: RefLike, index: number): boolean => {
    if (!input.leaves) return false;
    const last = siblingLast.get(refKey(r));
    if (last === undefined || last !== index - 1) return false;
    const size = sizeOf(r);
    const budget = node.budgetHours === null && input.hoursPerWeek === undefined ? 0 : leafBudget(node);
    return size === null || budget <= 0 || size > budget * share;
  };
  const readBefore = (node: PlanNode, key: string): boolean => {
    let found = false;
    walk(input.root, (n) => {
      if (found || n.id === input.root.id || n.id === node.id || n.end >= node.start) return;
      if (refsOf(n).some((r) => isRead(r) && refKey(r) === key)) found = true;
    });
    return found;
  };

  // The parent's practice reservation binds its children's sourced rows, by source and format, for the formats it
  // reserved. A source a heading reserves anywhere is used only where it is reserved: a unit whose parent reserved none
  // of it takes none of it (the reserved-source rule). A source no heading reserves may be taken by any unit. A week
  // split by hand counts only for its own days: its reservation is what it did itself.
  const practiceReserved = parentNode?.practiceCovers ?? [];
  const reservedFormats = new Set(practiceReserved.map((c) => c.format));
  const sourceKey = (r: { format: PracticeFormat; id: string | null }) => `${r.format}:${r.id}`;
  const parentCovers = (r: { format: PracticeFormat; id: string | null }) => practiceReserved.filter((c) => c.id === r.id && c.format === r.format);
  const below = new Set<string>();
  for (const n of input.nodes) walk(n, (d) => void below.add(d.id));
  const reservedSomewhere = new Set<string>();
  walk(input.root, (n) => {
    if (!below.has(n.id) && !n.manualSplit) for (const c of n.practiceCovers ?? []) if (c.id !== null) reservedSomewhere.add(sourceKey(c));
  });
  // Item lists: an item is one position of a source's list (`id#position`). Rows of units outside this level already
  // did theirs, and this level's do theirs as it goes: an item is done once in the plan. A heading's run is held against
  // other headings' runs, less what the parent reserved (its own level settled that), and its siblings' as it goes.
  const listedSource = (id: string | null) => id !== null && aliases.items(id) > 0;
  const itemKey = (id: string, position: number) => `${id}#${position}`;
  const inRuns = (runs: PracticeCover[], position: number) => runs.some((c) => itemPositions(c).includes(position));
  const parentItems = new Set(practiceReserved.flatMap((c) => (c.id !== null ? itemPositions(c).map((n) => itemKey(c.id!, n)) : [])));
  const doneBy = new Map<string, string>();
  const heldBy = new Map<string, string>();
  walk(input.root, (n) => {
    if (n.id === input.root.id || skip.has(n.id)) return;
    for (const r of n.practice ?? []) if (r.id !== null && r.itemFrom && !doneBy.has(itemKey(r.id, r.itemFrom))) doneBy.set(itemKey(r.id, r.itemFrom), label(n));
    for (const c of n.practiceCovers ?? []) {
      if (c.id === null) continue;
      for (const k of itemPositions(c).map((p) => itemKey(c.id!, p))) if (!parentItems.has(k) && !heldBy.has(k)) heldBy.set(k, label(n));
    }
  });

  const withRefs = input.nodes.filter((n) => refsOf(n).length > 0);
  // Budgets are checked once the level holds anything to budget, and only where there is a budget: without the
  // learner's hours only week leaves carry one; with them, days do too.
  const hasRows = withRefs.length > 0 || input.nodes.some((n) => (n.practice ?? []).length > 0);
  const budgeted = (node: PlanNode) => hasRows && (node.budgetHours !== null || input.hoursPerWeek !== undefined);
  if (input.leaves && withRefs.length > 0) {
    // A unit given to practice may read nothing.
    const noMust = input.nodes.filter((n) => !(n.materials ?? []).some((r) => r.tier === "must") && (n.practice ?? []).length === 0);
    if (noMust.length > 0) facts.push(`no must: ${noMust.map(label).join(", ")}`);
  }

  /**
   * The week rule over `units` (a week leaf, or a week's days): must-reading within the week's reading budget, and
   * practice within the week's practice budgets. A block format (`isBlockFormat`) comes whole, so it is budgeted over
   * the plan, not the week: the blocks a week holds take their minutes from the per-item formats' budgets, and a week
   * without one gives its slice to them, shared by their picks' shares. Block formats have no budget of their own in
   * a week; the week's practice as a whole is held to its total instead.
   */
  const weekRule = (units: PlanNode[], index: number, unit: string, weekMinutes: number) => {
    const budgets = practiceBudgets(input.split, weekMinutes, input.materials);
    let must = 0;
    let should = 0;
    const assigned = new Map<PracticeFormat, number>();
    for (const n of units) {
      const tiers = tierMinutes(n.materials);
      must += tiers.must;
      should += tiers.should;
      for (const r of n.practice ?? []) assigned.set(r.format, (assigned.get(r.format) ?? 0) + r.minutes);
    }
    if (must > budgetCeiling(budgets.reading)) {
      breach("over-budget", index, unit, [], `${unit}'s must-reading is ${must} min against a budget of about ${budgets.reading} min`);
    }
    const left = Math.max(0, budgets.reading - must);
    if (should > left) facts.push(`${unit} should-reading is ${should} min, more than the ${left} min must-reading leaves of the reading budget`);
    const formats = PRACTICE_FORMATS.filter((f) => budgets.practice[f] !== undefined || assigned.has(f));
    const sum = (fs: PracticeFormat[], of: (f: PracticeFormat) => number) => fs.reduce((total, f) => total + of(f), 0);
    const budgetOf = (f: PracticeFormat) => budgets.practice[f] ?? 0;
    const usedOf = (f: PracticeFormat) => assigned.get(f) ?? 0;
    const blocks = formats.filter(isBlockFormat);
    const perItem = formats.filter((f) => !isBlockFormat(f));
    // The per-item formats' budgets, with the block slices the week leaves them (none below 0), shared by their picks.
    const pool = Math.max(0, sum(perItem, budgetOf) + sum(blocks, budgetOf) - sum(blocks, usedOf));
    const shares = perItem.map((f) => (budgets.practice[f] === undefined ? 0 : (activePicks(input.split).find((p) => p.format === f)?.share ?? 0)));
    const scaled = blocks.length > 0 ? shareOut(pool, shares) : perItem.map(budgetOf);
    const short: string[] = [];
    let perItemOver = false;
    perItem.forEach((f, i) => {
      const minutes = usedOf(f);
      const budget = scaled[i];
      const name = PRACTICE_REGISTRY[f].label;
      if (minutes > budgetCeiling(budget)) {
        perItemOver = true;
        breach("over-budget", index, unit, [], `${unit}'s ${name} practice is ${minutes} min against a budget of about ${budget} min`);
      } else if (minutes < budget / SHARE_TOLERANCE - BUDGET_SLACK) short.push(`${name} ${minutes} of about ${budget} min`);
    });
    if (short.length > 0) facts.push(`${unit} practice short: ${short.join(", ")}`);
    // With blocks, the week's practice as a whole; a per-item breach already names the excess against what the blocks
    // left. Without blocks the per-format budgets are the whole practice budget and hold it on their own.
    const total = sum(formats, usedOf);
    const totalBudget = sum(formats, budgetOf);
    if (blocks.length > 0 && !perItemOver && total > budgetCeiling(totalBudget)) {
      breach("over-budget", index, unit, [], `${unit}'s practice is ${total} min against a budget of about ${totalBudget} min`);
    }
  };

  input.nodes.forEach((node, index) => {
    const unit = label(node);
    const refs = refsOf(node);
    const reads = refs.filter(isRead);
    const whole = reads.filter((r) => !r.chapter && listed(r.id) && !legacy(r));
    if (whole.length > 0) breach("whole-book", index, unit, whole, `${unit} refers to ${names(whole)} as a whole; use its chapters`);
    const chaptered = reads.filter((r) => !whole.includes(r));
    if (hasReservation) {
      const outside = chaptered.filter((r) => !reservedKeys.has(refKey(r)) && !reservedWhole.has(r.id));
      if (outside.length > 0) breach("outside", index, unit, outside, `${unit} ${verb} ${names(outside)}, which ${label(parentNode!)} did not reserve`);
    }
    const byHolder = new Map<string, RefLike[]>();
    for (const r of chaptered) {
      if (byTopic(r)) continue;
      const sibling = siblingLast.get(refKey(r));
      const holder = taken.get(refKey(r)) ?? (sibling !== undefined && !mayShare(node, r, index) ? label(input.nodes[sibling]) : undefined);
      if (holder) byHolder.set(holder, [...(byHolder.get(holder) ?? []), r]);
    }
    for (const [holder, rs] of byHolder) breach("overlap", index, unit, rs, `${unit} ${verb} ${names(rs)}, which ${holder} holds`);
    for (const r of reads) siblingLast.set(refKey(r), index);

    const unread = refs.filter((r) => !isRead(r) && !readBefore(node, refKey(r)));
    if (unread.length > 0) breach("review-before-read", index, unit, unread, `${unit} reviews ${names(unread)}, which no earlier unit reads`);

    if (input.leaves) {
      const rows = node.practice ?? [];
      for (const r of rows.filter((r) => !r.generated && r.id !== null)) {
        const covers = parentCovers(r);
        const from = aliases.alias(r.id!) ?? r.id!;
        const what = r.itemFrom ? rowLabel(r) : `${rowLabel(r)} from ${from}`;
        const notReserved = () => `${unit} assigns ${what}, which ${label(parentNode!)} did not reserve`;
        if (listedSource(r.id) && !r.itemFrom) facts.push(`${unit} assigns ${what} without an item`);
        // Another source of a format the parent reserved: the rule from before item lists, a breach over saved rows too.
        if (reservedFormats.has(r.format) && covers.length === 0) {
          practiceBreach("practice-outside", index, unit, r, notReserved());
          continue;
        }
        if (parentNode && covers.length === 0 && reservedSomewhere.has(sourceKey(r))) {
          newRule(rowBreach("practice-outside", index, unit, r, notReserved()), node, r);
          continue;
        }
        if (!listedSource(r.id) || !r.itemFrom) continue;
        const runs = covers.filter((c) => itemPositions(c).length > 0);
        if (runs.length > 0 && !inRuns(runs, r.itemFrom)) {
          newRule(rowBreach("practice-outside", index, unit, r, notReserved()), node, r);
          continue;
        }
        const key = itemKey(r.id!, r.itemFrom);
        const holder = doneBy.get(key);
        if (holder) newRule(rowBreach("practice-overlap", index, unit, r, `${unit} assigns ${what}, which ${holder} already assigns`), node, r);
        else doneBy.set(key, unit);
      }
      // The drafter's resolver refuses these; a revision may still bring them.
      const ownReading = new Set((node.materials ?? []).filter(isRead).map((r) => r.id));
      for (const r of rows.filter((r) => r.generated)) {
        const why =
          r.format === "recall"
            ? r.id !== null && ownReading.has(r.id)
              ? null
              : "not from its own reading"
            : PRACTICE_REGISTRY[r.format].generated === "never"
              ? "which is never written"
              : null;
        if (why) practiceBreach("practice-generated", index, unit, r, `${unit} writes ${rowName(r.format, r.task)} itself, ${why}`);
      }

      // A week split by hand is budgeted through its days.
      if (!budgeted(node) || (node.level !== "day" && (node.children?.length ?? 0) > 0)) return;
      const budget = leafBudget(node);
      if (budget <= 0) return;
      const { must, should } = tierMinutes(node.materials);
      const total = must + should + rows.reduce((sum, r) => sum + r.minutes, 0);
      if (node.level === "day" && total > budgetCeiling(budget)) {
        breach("over-budget", index, unit, [], `${unit} is ${total} min of reading and practice against a budget of about ${budget} min`);
      } else if (total > budget) facts.push(`${unit} over budget: ${total} of ${budget} min`);
      if (node.level !== "day") weekRule([node], index, unit, budget);
    } else {
      const known = reads.reduce((sum, r) => sum + knownMinutes(r), 0);
      const budget = budgetFor(weeksOf(input.root, node, input.daysPerWeek), input.hoursPerWeek) * 60 * share;
      if (known > budget * SHARE_TOLERANCE) {
        breach("over-budget", index, unit, [], `${unit} reserves about ${known} min of reading against a budget of about ${Math.round(budget)} min`);
      }
      // Practice reservations: the parent's sources only, a listed source by a run inside the parent's, each item once.
      for (const c of (node.practiceCovers ?? []).filter((c) => c.id !== null)) {
        const covers = parentCovers(c);
        const name = coverLabel(c);
        const notReserved = () => `${unit} reserves ${name}, which ${label(parentNode!)} did not reserve`;
        if (parentNode && covers.length === 0 && (reservedFormats.has(c.format) || reservedSomewhere.has(sourceKey(c)))) {
          newRule(coverBreach("practice-outside", index, unit, c, notReserved()), node, c);
          continue;
        }
        if (!listedSource(c.id)) continue;
        const own = itemPositions(c);
        if (own.length === 0) {
          facts.push(`${unit} reserves ${name} without a run of items`);
          continue;
        }
        const runs = covers.filter((p) => itemPositions(p).length > 0);
        if (runs.length > 0 && own.some((n) => !inRuns(runs, n))) {
          newRule(coverBreach("practice-outside", index, unit, c, notReserved()), node, c);
          continue;
        }
        const held = new Map<string, number[]>();
        for (const n of own) {
          const holder = heldBy.get(itemKey(c.id!, n));
          if (holder) held.set(holder, [...(held.get(holder) ?? []), n]);
        }
        const base = aliases.alias(c.id!) ?? c.id!;
        if (held.size > 0) {
          const whose = [...held].map(([holder, ns]) => `${holder} holds ${itemAliases(base, ns)}`).join(" and ");
          newRule(coverBreach("practice-overlap", index, unit, c, `${unit} reserves ${name}, but ${whose}`), node, c);
        }
        for (const n of own) if (!heldBy.has(itemKey(c.id!, n))) heldBy.set(itemKey(c.id!, n), unit);
      }
    }
  });
  facts.push(...itemListFacts(input, aliases, parentNode, skip, label));

  // A week's days together: the week rule, named for the week.
  if (input.leaves && input.nodes[0].level === "day" && hasRows && input.hoursPerWeek !== undefined) {
    weekRule(input.nodes, -1, parentNode ? label(parentNode) : "Week 1", budgetFor(1, input.hoursPerWeek) * 60);
  }

  if (parentNode && hasReservation) {
    const readKeys = new Set(input.nodes.flatMap((n) => refsOf(n).filter(isRead).map(refKey)));
    const readIds = new Set(input.nodes.flatMap((n) => refsOf(n).filter(isRead).map((r) => r.id)));
    const unread = (parentNode.covers ?? []).filter(isRead).filter((r) => (r.chapter ? !readKeys.has(refKey(r)) : !readIds.has(r.id)));
    if (unread.length > 0) {
      const unit = label(parentNode);
      breach("unread-reservation", -1, unit, unread, `${unit} reserved ${names(unread)}, which no ${input.nodes[0].level} reads`);
    }
  }

  // Block formats over the plan, as guidance and facts: what the leaves placed up to these units, against each
  // format's share of the plan's practice; and, once the plan's last unit is drafted, a picked block never placed.
  if (input.leaves) {
    const planMinutes = budgetFor(weeksOf(input.root, input.root, input.daysPerWeek), input.hoursPerWeek) * 60;
    const through = input.nodes[input.nodes.length - 1].end;
    const last = through >= input.root.end;
    for (const [f, total] of Object.entries(planBlockBudgets(input.split, planMinutes, input.materials)) as [PracticeFormat, number][]) {
      const placed = placedMinutes(input.root, f, through);
      const name = PRACTICE_REGISTRY[f].label;
      if (placed > budgetCeiling(total)) facts.push(`${name} placed so far is ${placed} min, past its about ${total} min over the plan`);
      else if (last && placed === 0 && total > 0) facts.push(`no ${name} placed over the plan, against about ${total} min for it`);
    }
  }

  const backbone = input.materials.find((m) => m.backbone);
  if (backbone) {
    const numbers = (n: PlanNode) => chapterNumbers(n, backbone);
    const steps: ChapterStep[] = input.nodes.map((n) => ({ label: label(n), chapters: numbers(n) }));
    // Start from where the plan before these units left the backbone, so an expansion continues in order.
    const before = chaptersBefore(input.root, input.nodes[0], backbone);
    facts.push(...chapterRegressions([{ label: "earlier units", chapters: before }, ...steps]));
    const listed = listedChapters(backbone.toc);
    if (input.top && !input.leaves) {
      const gaps = chapterGaps(steps.flatMap((s) => s.chapters), listed);
      if (gaps.length > 0) facts.push(`backbone ch. ${formatChapters(gaps)} not reserved`);
    }
    // A note naming a chapter the list does not hold (one the allocation cut): a fact, not a breach.
    if (listed) {
      const outside = [...new Set(steps.flatMap((s) => s.chapters))].filter((c) => !listed.includes(c)).sort((a, b) => a - b);
      if (outside.length > 0) facts.push(`backbone ch. ${formatChapters(outside)} ${input.leaves ? "read" : "reserved"} outside the kept chapters`);
    }
  }
  return { facts, breaches };
}

/** "item 4", "items 3, 5–6". */
function itemsText(positions: number[]): string {
  return positions.length === 1 ? `item ${positions[0]}` : `items ${formatRuns(positions)}`;
}

/**
 * Facts on item lists once a level is checked. Headings: a run that goes back in its list, from where earlier units'
 * runs ended (as chapter regressions are); at the top, a listed source's items no heading reserves. Under a parent: the
 * items it reserved that none of its units assigns, or, for headings, reserves. They are not handed to later units.
 */
function itemListFacts(input: LevelCheckInput, aliases: MaterialAliases, parentNode: PlanNode | null, skip: ReadonlySet<string>, label: (n: PlanNode) => string): string[] {
  const facts: string[] = [];
  const base = (id: string) => aliases.alias(id) ?? id;
  const runsOf = (n: PlanNode) => (n.practiceCovers ?? []).filter((c) => c.id !== null && aliases.items(c.id) > 0 && itemPositions(c).length > 0);
  const sourceKey = (r: { format: PracticeFormat; id: string | null }) => `${r.format}:${r.id}`;
  /** Each listed source's positions in these runs, by format and source. */
  const bySource = (covers: PracticeCover[]) => {
    const out = new Map<string, { id: string; positions: number[] }>();
    for (const c of covers) {
      const entry = out.get(sourceKey(c)) ?? { id: c.id!, positions: [] };
      entry.positions.push(...itemPositions(c));
      out.set(sourceKey(c), entry);
    }
    return out;
  };
  if (!input.leaves) {
    const furthest = new Map<string, number>();
    const first = input.nodes[0];
    walk(input.root, (n) => {
      if (n.id === input.root.id || skip.has(n.id) || n.end >= first.start) return;
      for (const c of runsOf(n)) furthest.set(sourceKey(c), Math.max(furthest.get(sourceKey(c)) ?? 0, c.itemTo!));
    });
    for (const node of input.nodes) {
      for (const [k, { id, positions }] of bySource(runsOf(node))) {
        const [lo, hi] = [Math.min(...positions), Math.max(...positions)];
        const far = furthest.get(k) ?? 0;
        if (lo < far) facts.push(`${itemRun(base(id), lo, hi)} after item ${far} (${label(node)})`);
        furthest.set(k, Math.max(far, hi));
      }
    }
    if (input.top) {
      for (const { id, positions } of bySource(input.nodes.flatMap(runsOf)).values()) {
        const have = new Set(positions);
        const missing = Array.from({ length: aliases.items(id) }, (_, i) => i + 1).filter((n) => !have.has(n));
        if (missing.length > 0) facts.push(`${base(id)} ${itemsText(missing)} not reserved`);
      }
    }
  }
  if (parentNode) {
    for (const [k, { id, positions }] of bySource(runsOf(parentNode))) {
      const taken = new Set(
        input.leaves
          ? input.nodes.flatMap((n) => (n.practice ?? []).filter((r) => sourceKey(r) === k && r.itemFrom).map((r) => r.itemFrom!))
          : input.nodes.flatMap((n) => runsOf(n).filter((c) => sourceKey(c) === k).flatMap(itemPositions)),
      );
      const missing = [...new Set(positions)].filter((n) => !taken.has(n)).sort((a, b) => a - b);
      if (missing.length > 0) facts.push(`${itemsText(missing)} of ${base(id)} reserved by ${label(parentNode)} but not assigned`);
    }
  }
  return facts;
}

/** The backbone chapter numbers a node reads: from chapter references, or from the note of a row without one. */
function chapterNumbers(node: PlanNode, backbone: CheckMaterial): number[] {
  const out: number[] = [];
  for (const r of refsOf(node)) {
    if (r.id !== backbone.id || !isRead(r)) continue;
    if (r.chapter) out.push(chapterAt(backbone.toc, r.chapter)?.n ?? r.chapter);
    else out.push(...parseChapters(r.note));
  }
  return [...new Set(out)];
}

/** Backbone chapters read by leaves that come before `node` in plan order. */
function chaptersBefore(root: PlanNode, node: PlanNode | undefined, backbone: CheckMaterial): number[] {
  if (!node) return [];
  const out: number[] = [];
  let reached = false;
  walk(root, (n) => {
    if (reached || n.id === root.id) return;
    if (n.id === node.id) {
      reached = true;
      return;
    }
    if (n.children === null && n.end < node.start) out.push(...chapterNumbers(n, backbone));
  });
  return out;
}

/**
 * Every sibling group of a tree through `levelChecks`, in walk order. `nodes` is that walk order without the root, and
 * each breach's `index` points into it, so `dropBreaches(nodes, breaches)` works on the whole tree. With `original`
 * (revision), a practice row or reservation unchanged from it is saved and the rules on item lists and reserved sources
 * state facts only for it, while a row added or changed breaches as a drafted one does; without it, every row is saved.
 */
export function treeChecks(
  root: PlanNode,
  materials: CheckMaterial[],
  opts: { granularity: Granularity; hoursPerWeek?: number; daysPerWeek: number; split?: PlanSplit | null; original?: PlanNode },
): LevelChecks & { nodes: PlanNode[] } {
  const { granularity, original, ...shares } = opts;
  const saved = original ? savedPracticeRows(original) : () => true;
  const nodes: PlanNode[] = [];
  const position = new Map<string, number>();
  walk(root, (n) => {
    if (n.id === root.id) return;
    position.set(n.id, nodes.length);
    nodes.push(n);
  });
  const facts: string[] = [];
  const breaches: Breach[] = [];
  walk(root, (n) => {
    const group = n.children;
    if (!group || group.length === 0) return;
    // Leaf-ness is the level's, not the node's: a hand-split week is still a week-sized leaf of a week plan.
    const level = group[0].level;
    const leaves = level === "day" || (level === "week" && granularity === "week");
    const out = levelChecks({ root, nodes: group, leaves, top: n.id === root.id, materials, unknownIds: [], saved, ...shares });
    facts.push(...out.facts);
    breaches.push(...out.breaches.map((b) => ({ ...b, index: b.index < 0 ? -1 : position.get(group[b.index].id)! })));
  });
  return { facts, breaches, nodes };
}

/** Removes the rows of droppable breaches from `nodes[breach.index]`; one line per breach for the facts. */
export function dropBreaches(nodes: PlanNode[], breaches: Breach[]): string[] {
  const out: string[] = [];
  for (const b of breaches) {
    if (!DROPPABLE.has(b.kind) || b.index < 0) continue;
    const node = nodes[b.index];
    if (!node) continue;
    if (b.practice || b.practiceCovers) {
      // One row or reservation per entry, the last that matches: a repeated item keeps its first use.
      for (const p of b.practice ?? []) {
        const rows = node.practice ?? [];
        const at = rows.findLastIndex((r) => p.format === r.format && p.id === r.id && p.task === r.task && (p.itemFrom ?? null) === (r.itemFrom ?? null));
        if (at >= 0) rows.splice(at, 1);
      }
      for (const p of b.practiceCovers ?? []) {
        const covers = node.practiceCovers ?? [];
        const at = covers.findLastIndex((c) => p.format === c.format && p.id === c.id && (p.itemFrom ?? null) === (c.itemFrom ?? null) && (p.itemTo ?? null) === (c.itemTo ?? null));
        if (at >= 0) covers.splice(at, 1);
      }
      if (node.practice?.length === 0) delete node.practice;
      if (node.practiceCovers?.length === 0) delete node.practiceCovers;
      out.push(`dropped ${b.names} from ${b.unit}: ${b.kind}`);
      continue;
    }
    const keys = new Set(b.refs.map(refKey));
    if (node.covers) {
      node.covers = node.covers.filter((r) => !keys.has(refKey(r)));
      if (node.covers.length === 0) delete node.covers;
    }
    if (node.materials) {
      node.materials = node.materials.filter((r) => !keys.has(refKey(r)));
      if (node.materials.length === 0) delete node.materials;
    }
    out.push(`dropped ${b.names} from ${b.unit}: ${b.kind}`);
  }
  return out;
}

/**
 * Chapter rows take their minutes from the list: the read rows across `nodes` that carry one chapter are rescaled so
 * they add up to its listed size, keeping the model's proportions (rounding remainder to the last row); rows that
 * all say zero share it evenly. Reviews and chapters without a size keep the model's minutes.
 */
export function sizeChapterRows(nodes: PlanNode[], materials: Pick<Material, "id" | "toc">[]): void {
  const byId = new Map(materials.map((m) => [m.id, m]));
  const groups = new Map<string, MaterialRef[]>();
  for (const node of nodes) {
    for (const row of node.materials ?? []) {
      if (!row.chapter || (row.activity ?? "read") !== "read") continue;
      const key = refKey(row);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }
  for (const rows of groups.values()) {
    const size = chapterAt(byId.get(rows[0].id)?.toc, rows[0].chapter)?.minutes;
    if (!size) continue;
    const total = rows.reduce((sum, r) => sum + (r.minutes ?? 0), 0);
    let given = 0;
    rows.forEach((row, i) => {
      if (i === rows.length - 1) row.minutes = size - given;
      else {
        row.minutes = total > 0 ? Math.round(((row.minutes ?? 0) * size) / total) : Math.round(size / rows.length);
        given += row.minutes;
      }
    });
  }
}

/** Where a material is used, for the remove-material confirmation. */
export function assignmentsOf(root: PlanNode, id: string): { node: PlanNode; label: string; role: "covers" | "assigned" }[] {
  const out: { node: PlanNode; label: string; role: "covers" | "assigned" }[] = [];
  walk(root, (n) => {
    if (n.id === root.id) return;
    if (n.covers?.some((r) => r.id === id)) out.push({ node: n, label: fullLabelOf(root, n), role: "covers" });
    if (n.materials?.some((r) => r.id === id)) out.push({ node: n, label: fullLabelOf(root, n), role: "assigned" });
  });
  return out;
}

/**
 * The Read table a week split by hand was planned with: its reservation's rows that kept a tier. Empty for weeks split
 * before tiers were kept, and for headings.
 */
export function keptReadTable(covers: CoverRef[] | undefined): MaterialRef[] {
  return (covers ?? []).flatMap(({ tier, minutes, ...ref }) => (tier ? [{ ...ref, tier, minutes: minutes ?? null }] : []));
}

/**
 * A reservation the model wrote back, with the tier and minutes of the rows it had before. The model sees and writes
 * only ids and notes, so a split week's kept Read table would otherwise be lost on any revision.
 */
export function keepCoverTiers(next: CoverRef[], before: CoverRef[] | undefined): CoverRef[] {
  const old = new Map((before ?? []).filter((r) => r.tier).map((r) => [refKey(r), r]));
  if (old.size === 0) return next;
  return next.map((r) => {
    const o = old.get(refKey(r));
    return o?.tier ? { ...r, tier: o.tier, minutes: o.minutes ?? null } : r;
  });
}

/**
 * What a heading's practice reservations become when the model rewrites them. Reservations it wrote back with ids only
 * regain the `task` and `minutes` of the matching one it had before (same format and source, and the same first item for
 * a run of a listed source); values they already have are kept. One written back without its run takes the run of the
 * only reservation of that source it had. The model cannot name a generated reservation: one with no source (`id:
 * null`), or a recall row that cites its reading, which `resolvePracticeCovers` drops since the reading serves no
 * practice of that format (`practiceOf`). Those carry forward unchanged, after the rewritten list. A week split by hand
 * would otherwise lose its rows on any revision.
 */
export function keepPracticeCovers(next: PracticeCover[], before: PracticeCover[] | undefined, practiceOf: (id: string) => PracticeFormat | null): PracticeCover[] {
  const sourced = (before ?? []).filter((r) => r.id !== null && practiceOf(r.id) === r.format);
  const generated = (before ?? []).filter((r) => r.id === null || practiceOf(r.id) !== r.format);
  const restored = next.map((r) => {
    const same = sourced.filter((o) => o.format === r.format && o.id === r.id);
    const o = r.itemFrom ? same.find((x) => x.itemFrom === r.itemFrom) : same.length === 1 ? same[0] : same.find((x) => !x.itemFrom);
    if (!o) return r;
    return {
      ...r,
      ...(r.task === undefined && o.task !== undefined ? { task: o.task } : {}),
      ...(r.minutes === undefined && o.minutes !== undefined ? { minutes: o.minutes } : {}),
      ...(!r.itemFrom && o.itemFrom && o.itemTo ? { itemFrom: o.itemFrom, itemTo: o.itemTo } : {}),
    };
  });
  return [...restored, ...generated];
}

/** A copy of the tree without any reference to `id`. */
export function removeMaterialRefs(root: PlanNode, id: string): PlanNode {
  const next = cloneTree(root);
  walk(next, (n) => {
    if (n.covers) n.covers = n.covers.filter((r) => r.id !== id);
    if (n.materials) n.materials = n.materials.filter((r) => r.id !== id);
    // Generated practice rows have no source (`id: null`) and stay.
    if (n.practice) n.practice = n.practice.filter((r) => r.id !== id);
    if (n.practiceCovers) n.practiceCovers = n.practiceCovers.filter((r) => r.id !== id);
    if (n.covers?.length === 0) delete n.covers;
    if (n.materials?.length === 0) delete n.materials;
    if (n.practice?.length === 0) delete n.practice;
    if (n.practiceCovers?.length === 0) delete n.practiceCovers;
  });
  return next;
}

/**
 * Rewrites every reference through `ids` (short id → uuid on save). References to ids not in the map are dropped
 * and counted, which is how a reference to an unknown or removed material is kept out of the database.
 */
export function remapTreeRefs(root: PlanNode, ids: ReadonlyMap<string, string>): { root: PlanNode; dropped: number } {
  const next = cloneTree(root);
  let dropped = 0;
  const map = <T extends { id: string }>(refs: T[] | undefined): T[] | undefined => {
    if (!refs) return refs;
    const out: T[] = [];
    for (const r of refs) {
      const id = ids.get(r.id);
      if (id) out.push({ ...r, id });
      else dropped += 1;
    }
    return out.length > 0 ? out : undefined;
  };
  // Practice with no source (`id: null`, a generated row) has nothing to map and stays.
  const mapPractice = <T extends { id: string | null }>(refs: T[] | undefined): T[] | undefined => {
    if (!refs) return refs;
    const out: T[] = [];
    for (const r of refs) {
      if (r.id === null) out.push(r);
      else {
        const id = ids.get(r.id);
        if (id) out.push({ ...r, id });
        else dropped += 1;
      }
    }
    return out.length > 0 ? out : undefined;
  };
  walk(next, (n) => {
    const covers = map(n.covers);
    const materials = map(n.materials);
    const practice = mapPractice(n.practice);
    const practiceCovers = mapPractice(n.practiceCovers);
    if (covers) n.covers = covers;
    else delete n.covers;
    if (materials) n.materials = materials;
    else delete n.materials;
    if (practice) n.practice = practice;
    else delete n.practice;
    if (practiceCovers) n.practiceCovers = practiceCovers;
    else delete n.practiceCovers;
  });
  return { root: next, dropped };
}

/** The backbone, if the list has one. */
export function backboneOf(materials: Material[]): Material | null {
  return materials.find((m) => m.backbone) ?? null;
}

/** Share of materials with a year in the last two years (the eval's recency metric). */
export function recencyShare(materials: Pick<Material, "year" | "origin">[], now = new Date()): number {
  const researched = materials.filter((m) => m.origin === "research");
  if (researched.length === 0) return 0;
  const recent = researched.filter((m) => m.year !== null && m.year >= now.getFullYear() - 2).length;
  return recent / researched.length;
}

/**
 * The learner's sources as materials without reading them: what the gate produces when every link is unreachable.
 * For the drafting eval and tests, where drafting is measured on its own and nothing may touch the network. Ids are
 * `M1…Mn` in list order, titles fall back to the host or the text itself, and nothing carries a verified badge.
 */
export function learnerMaterials(sources: SourceInput[]): Material[] {
  const unique = sources.filter((s, i, all) => all.findIndex((o) => o.url === s.url) === i);
  return unique.map((source, i) => {
    const type = source.type;
    const fallback = type === "note" || type === "file" ? source.url.trim() : (hostOf(source.url) ?? source.url);
    return {
      id: shortId(i),
      origin: "learner",
      type,
      kind: learnerKind(type, source.url),
      url: source.url,
      title: clip(source.title?.trim() || fallback, 300)!,
      author: null,
      year: null,
      why: null,
      backbone: false,
      verifiedAt: null,
      fetchedTitle: null,
      recommendedBy: [],
      sig: null,
    };
  });
}
