import { learnerKind } from "@/lib/ai/research/verify";
import { budgetFor, cloneTree, daysInWeekOf, fullLabelOf, parentOf, walk, weeksOf, type Granularity, type PlanNode } from "@/lib/planTree";
import { PRACTICE_FORMATS, PRACTICE_REGISTRY, weekBudgets, type PracticeFormat, type PracticePick } from "@/lib/practice";
import { dayMinutes, readingShareOf, type PlanSplit } from "@/lib/studyTime";
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
}

export interface MaterialAliases {
  alias(id: string, chapter?: number | null): string | undefined;
  resolve(alias: string): ResolvedAlias | undefined;
  /** How many chapters the material's list has; 0 without a list. */
  chapters(id: string): number;
  /** The format a practice source serves; null for a material that is reading only. */
  practice(id: string): PracticeFormat | null;
}

const ALIAS_RE = /^\[?\s*(m\d+)(?:\.(\d+))?\s*\]?$/i;

export function aliasMaterials(materials: Pick<Material, "id" | "toc" | "practice">[]): MaterialAliases {
  const toAlias = new Map<string, string>();
  const fromAlias = new Map<string, string>();
  const counts = new Map<string, number>();
  const formats = new Map<string, PracticeFormat>();
  materials.forEach((m, i) => {
    const alias = `M${i + 1}`;
    toAlias.set(m.id, alias);
    fromAlias.set(alias.toLowerCase(), m.id);
    counts.set(m.id, m.toc?.chapters.length ?? 0);
    if (m.practice) formats.set(m.id, m.practice.format);
  });
  return {
    alias: (id, chapter) => {
      const base = toAlias.get(id);
      return base === undefined ? undefined : chapter ? `${base}.${chapter}` : base;
    },
    resolve: (alias) => {
      const m = alias.match(ALIAS_RE);
      if (!m) return undefined;
      const id = fromAlias.get(m[1].toLowerCase());
      if (!id) return undefined;
      if (m[2] === undefined) return { id, chapter: null };
      const chapter = Number(m[2]);
      return chapter >= 1 && chapter <= (counts.get(id) ?? 0) ? { id, chapter } : undefined;
    },
    chapters: (id) => counts.get(id) ?? 0,
    practice: (id) => formats.get(id) ?? null,
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
    if (!resolved) {
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
    if (!resolved) {
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
  return (split?.formats ?? []).some((p) => p.format === f) ? (f as PracticeFormat) : null;
}

/** "Problems "Arrays 1–6"": a refused row as the facts name it. */
function rowName(format: string, task: string): string {
  const f = format.trim().toLowerCase();
  const label = (PRACTICE_FORMATS as readonly string[]).includes(f) ? PRACTICE_REGISTRY[f as PracticeFormat].label : format.trim();
  const t = task.trim();
  return `${label} "${t.length > 60 ? `${t.slice(0, 59)}…` : t}"`;
}

/**
 * Resolves the model's practice rows. A row of a format the split did not pick is refused. A row naming a practice
 * source of its own format keeps it; one whose source serves another format is refused. A row with no id is one the
 * model wrote (`generated`), refused when its format is never written. Recall written from reading must name a
 * resource the unit itself reads (`reads`, its Read table's ids), so a recall row with no id, or citing other reading,
 * is refused. An id not in the list is unknown; a reading id on any other format is refused, since it is no practice
 * source.
 */
export function resolvePracticeRefs(
  drafts: PracticeRefDraft[] | undefined,
  aliases: MaterialAliases,
  split: PlanSplit | null | undefined,
  reads: readonly string[] = [],
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
    const task = clip(draft.task, 300);
    if (!task) {
      refused.push(`${name}: no task`);
      continue;
    }
    const alias = draft.id?.trim();
    const resolved = alias ? aliases.resolve(alias) : undefined;
    if (alias && !resolved) {
      unknown.push(alias);
      continue;
    }
    const spec = PRACTICE_REGISTRY[format];
    const serves = resolved ? aliases.practice(resolved.id) : null;
    if (serves !== null && serves !== format) {
      refused.push(`${name}: ${alias} serves ${PRACTICE_REGISTRY[serves].label}, not ${spec.label}`);
      continue;
    }
    const generated = serves === null;
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
    const minutes = Number.isFinite(draft.minutes) ? Math.max(1, Math.min(600, Math.round(draft.minutes))) : 1;
    refs.push({ format, id: resolved?.id ?? null, task, done: clip(draft.done, 300) ?? spec.doneWhen, minutes, generated });
  }
  return { refs, unknown, refused };
}

/**
 * Resolves a heading's practice reservations. One whose format is not a pick, or whose material is no practice source
 * of that format, is dropped into `unknown`.
 */
export function resolvePracticeCovers(
  drafts: PracticeCoverDraft[] | undefined,
  aliases: MaterialAliases,
  split: PlanSplit | null | undefined,
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
    refs.push({ format, id: resolved.id, note: clip(draft.note, 300) });
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

/** The split's picks with their sources. Empty when the plan is all reading. */
export function pickSources(split: PlanSplit | null | undefined, materials: Pick<Material, "id" | "practice">[]): PickSources[] {
  const hasReading = materials.some((m) => !m.practice);
  return (split?.formats ?? []).map((pick) => {
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
  materials: Pick<Material, "id" | "practice">[],
): ReturnType<typeof weekBudgets> {
  if ((split?.formats ?? []).length === 0) return { reading: Math.round(weekMinutes * (readingShareOf(split) ?? MUST_SHARE)), practice: {} };
  const budgets = weekBudgets(split, weekMinutes);
  for (const { pick, assignable } of pickSources(split, materials)) {
    if (assignable) continue;
    budgets.reading += budgets.practice[pick.format] ?? 0;
    delete budgets.practice[pick.format];
  }
  return budgets;
}

/** One fact per pick that can't be assigned, for the drafting call's facts. */
export function noSourceFacts(split: PlanSplit | null | undefined, materials: Pick<Material, "id" | "practice">[]): string[] {
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

/** Chapters between 1 and the last reserved one that no heading reserves. */
export function chapterGaps(reserved: number[]): number[] {
  if (reserved.length === 0) return [];
  const have = new Set(reserved);
  const gaps: number[] = [];
  for (let c = 1; c <= Math.max(...reserved); c++) if (!have.has(c)) gaps.push(c);
  return gaps;
}

function formatChapters(chapters: number[]): string {
  return chapters.length > 6 ? `${chapters.slice(0, 6).join(", ")}, …` : chapters.join(", ");
}

/**
 * `practice-outside`: a sourced practice row of a format the parent reserved, from a source it did not reserve.
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
  | "practice-generated";

/** The breaches a drop can cure: the row goes, the unit keeps the rest. Over-budget and unread reservations stay facts. */
export const DROPPABLE: ReadonlySet<BreachKind> = new Set<BreachKind>(["outside", "overlap", "whole-book", "review-before-read", "practice-outside", "practice-generated"]);

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
  /** The practice rows a practice breach names, which a drop removes. */
  practice?: Pick<PracticeRef, "format" | "id" | "task">[];
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
}

/** How far must-reading may run past the plan's reading share before it is worth reporting. */
export const SHARE_TOLERANCE = 1.25;

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
  const share = readingShareOf(input.split) ?? MUST_SHARE;
  const leafBudget = (node: PlanNode) => budgetMinutes(node, input.hoursPerWeek, daysInWeekOf(input.root, node, input.daysPerWeek));
  const verb = input.leaves ? "reads" : "reserves";
  const names = (refs: RefLike[]) => formatAliases(refs.map(toResolved), aliases);
  const breach = (kind: BreachKind, index: number, unit: string, refs: RefLike[], text: string) => breaches.push({ kind, index, unit, refs: refs.map(toResolved), names: names(refs), text });
  const practiceBreach = (kind: BreachKind, index: number, unit: string, row: PracticeRef, text: string) =>
    breaches.push({ kind, index, unit, refs: [], names: rowName(row.format, row.task), text, practice: [{ format: row.format, id: row.id, task: row.task }] });

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
  // reserved; a format it reserved nothing of may take any source of that format, as the prompt offers.
  const practiceReserved = parentNode?.practiceCovers ?? [];
  const reservedFormats = new Set(practiceReserved.map((c) => c.format));
  const inPracticeReservation = (r: PracticeRef) => practiceReserved.some((c) => c.id === r.id && c.format === r.format);

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

  /** The week rule over `units` (a week leaf, or a week's days): must-reading and each pick within the week's budgets. */
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
    if (must > budgets.reading * SHARE_TOLERANCE + 10) {
      breach("over-budget", index, unit, [], `${unit}'s must-reading is ${must} min against a budget of about ${budgets.reading} min`);
    }
    const left = Math.max(0, budgets.reading - must);
    if (should > left) facts.push(`${unit} should-reading is ${should} min, more than the ${left} min must-reading leaves of the reading budget`);
    const formats = PRACTICE_FORMATS.filter((f) => budgets.practice[f] !== undefined || assigned.has(f));
    const short: string[] = [];
    for (const f of formats) {
      const minutes = assigned.get(f) ?? 0;
      const budget = budgets.practice[f] ?? 0;
      const name = PRACTICE_REGISTRY[f].label;
      if (minutes > budget * SHARE_TOLERANCE + 10) breach("over-budget", index, unit, [], `${unit}'s ${name} practice is ${minutes} min against a budget of about ${budget} min`);
      else if (minutes < budget / SHARE_TOLERANCE - 10) short.push(`${name} ${minutes} of about ${budget} min`);
    }
    if (short.length > 0) facts.push(`${unit} practice short: ${short.join(", ")}`);
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
      for (const r of rows.filter((r) => !r.generated && r.id !== null && reservedFormats.has(r.format) && !inPracticeReservation(r))) {
        const from = aliases.alias(r.id!) ?? r.id;
        practiceBreach("practice-outside", index, unit, r, `${unit} assigns ${rowName(r.format, r.task)} from ${from}, which ${label(parentNode!)} did not reserve`);
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
      if (node.level === "day" && total > budget * SHARE_TOLERANCE + 10) {
        breach("over-budget", index, unit, [], `${unit} is ${total} min of reading and practice against a budget of about ${budget} min`);
      } else if (total > budget) facts.push(`${unit} over budget: ${total} of ${budget} min`);
      if (node.level !== "day") weekRule([node], index, unit, budget);
    } else {
      const known = reads.reduce((sum, r) => sum + knownMinutes(r), 0);
      const budget = budgetFor(weeksOf(input.root, node, input.daysPerWeek), input.hoursPerWeek) * 60 * share;
      if (known > budget * SHARE_TOLERANCE) {
        breach("over-budget", index, unit, [], `${unit} reserves about ${known} min of reading against a budget of about ${Math.round(budget)} min`);
      }
    }
  });

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

  const backbone = input.materials.find((m) => m.backbone);
  if (backbone) {
    const numbers = (n: PlanNode) => chapterNumbers(n, backbone);
    const steps: ChapterStep[] = input.nodes.map((n) => ({ label: label(n), chapters: numbers(n) }));
    // Start from where the plan before these units left the backbone, so an expansion continues in order.
    const before = chaptersBefore(input.root, input.nodes[0], backbone);
    facts.push(...chapterRegressions([{ label: "earlier units", chapters: before }, ...steps]));
    if (input.top && !input.leaves) {
      const gaps = chapterGaps(steps.flatMap((s) => s.chapters));
      if (gaps.length > 0) facts.push(`backbone ch. ${formatChapters(gaps)} not reserved`);
    }
  }
  return { facts, breaches };
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
 * each breach's `index` points into it, so `dropBreaches(nodes, breaches)` works on the whole tree.
 */
export function treeChecks(
  root: PlanNode,
  materials: CheckMaterial[],
  opts: { granularity: Granularity; hoursPerWeek?: number; daysPerWeek: number; split?: PlanSplit | null },
): LevelChecks & { nodes: PlanNode[] } {
  const { granularity, ...shares } = opts;
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
    const out = levelChecks({ root, nodes: group, leaves, top: n.id === root.id, materials, unknownIds: [], ...shares });
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
    if (b.practice) {
      const named = b.practice;
      node.practice = (node.practice ?? []).filter((r) => !named.some((p) => p.format === r.format && p.id === r.id && p.task === r.task));
      if (node.practice.length === 0) delete node.practice;
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
 * regain the `task` and `minutes` of the matching one it had before (same format and source); values they already have
 * are kept. The model cannot name a generated reservation: one with no source (`id: null`), or a recall row that cites
 * its reading, which `resolvePracticeCovers` drops since the reading serves no practice of that format (`practiceOf`).
 * Those carry forward unchanged, after the rewritten list. A week split by hand would otherwise lose its rows on any
 * revision.
 */
export function keepPracticeCovers(next: PracticeCover[], before: PracticeCover[] | undefined, practiceOf: (id: string) => PracticeFormat | null): PracticeCover[] {
  const old = new Map((before ?? []).filter((r) => r.id !== null && (r.task !== undefined || r.minutes !== undefined)).map((r) => [`${r.format}:${r.id}`, r]));
  const generated = (before ?? []).filter((r) => r.id === null || practiceOf(r.id) !== r.format);
  const restored = next.map((r) => {
    const o = old.get(`${r.format}:${r.id}`);
    if (!o) return r;
    return { ...r, ...(r.task === undefined && o.task !== undefined ? { task: o.task } : {}), ...(r.minutes === undefined && o.minutes !== undefined ? { minutes: o.minutes } : {}) };
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
