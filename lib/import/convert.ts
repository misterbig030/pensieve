import { toTreeInput } from "@/lib/planInput";
import {
  DEFAULT_DAYS_PER_WEEK,
  DEFAULT_HOURS_PER_WEEK,
  MAX_DAYS_PER_WEEK,
  MONTH_WEEKS,
  childLevel,
  layout,
  makeNode,
  makeRoot,
  type Granularity,
  type PlanLevel,
  type PlanNode,
} from "@/lib/planTree";
import { PRACTICE_FORMATS, PRACTICE_REGISTRY, numberRuns, shareOut, type PracticeFormat, type PracticePick } from "@/lib/practice";
import {
  MATERIAL_KINDS,
  MAX_PRACTICE_ITEMS,
  MIN_PRACTICE_ITEMS,
  clip,
  shortId,
  type CoverRef,
  type Material,
  type MaterialKind,
  type MaterialRef,
  type PracticeCover,
  type PracticeItem,
  type PracticeRef,
} from "@/lib/schemas/material";
import { MAX_UNIT_MINUTES, type PlanTreeInput, type UnitTime } from "@/lib/schemas/plan";
import { SPLIT_FROM_FILE, clampHours, type PlanSplit } from "@/lib/studyTime";
import type { ImportDraft, ImportPracticeDraft, ImportReadingDraft, ImportUnitDraft } from "./schema";

/**
 * Turns the import model's answer into the app's plan shapes: the materials list, the unit tree as the draft page
 * takes it, and the split. Pure. The structure is copied as the draft gives it: units are never added, merged, split
 * or reordered, except that a day-only file's days are wrapped in weeks, since the app keeps top-level days for
 * one-week plans.
 */

export interface ImportedPlan {
  title: string;
  granularity: Granularity;
  hoursPerWeek: number;
  daysPerWeek: number;
  split: PlanSplit;
  materials: Material[];
  tree: PlanTreeInput;
  kept: string[];
  skipped: { heading: string; reason: string }[];
}

export type ConvertResult =
  | { ok: true; plan: ImportedPlan }
  | { ok: false; reason: "no_plan"; message: string }
  | { ok: false; reason: "too_long"; message: string };

/** The most top-level units an import keeps: the redraft schema's limit, so an imported track can always be redrafted. */
export const MAX_IMPORT_UNITS = 40;
export const TOO_LONG_MESSAGE = `This plan has more than ${MAX_IMPORT_UNITS} top-level units. Pensieve can import up to ${MAX_IMPORT_UNITS}.`;
const NO_PLAN_FALLBACK = "It has no units of time to copy.";
/** `split.practice` on an imported plan. */
export const IMPORT_SPLIT_PRACTICE = "From your plan";

/** The most rows of each kind one unit holds (`planTreeInputSchema`), and the most materials (`materialListSchema`). */
const MAX_UNIT_ROWS = 40;
const MAX_MATERIALS = 100;
/** Minutes for a row the file gives no time and whose format has no block size. */
const DEFAULT_ROW_MINUTES = 30;

type Skipped = { heading: string; reason: string };

/** A unit at its level in the app's tree. */
interface Unit {
  level: PlanLevel;
  draft: ImportUnitDraft;
  children: Unit[] | null;
}

export function convertDraft(draft: ImportDraft, fileName: string): ConvertResult {
  if (draft.kind === "no_plan") return { ok: false, reason: "no_plan", message: draft.reason.trim() || NO_PLAN_FALLBACK };
  if (draft.units.length === 0) return { ok: false, reason: "no_plan", message: NO_PLAN_FALLBACK };

  const hoursPerWeek = draft.hoursPerWeek && draft.hoursPerWeek > 0 ? clampHours(draft.hoursPerWeek) : DEFAULT_HOURS_PER_WEEK;
  const daysPerWeek =
    draft.daysPerWeek && draft.daysPerWeek > 0 ? Math.min(MAX_DAYS_PER_WEEK, Math.max(1, Math.round(draft.daysPerWeek))) : DEFAULT_DAYS_PER_WEEK;

  const tops = draft.level === "day" ? weeksOfDays(draft.units, daysPerWeek) : draft.units.map((u) => toUnit(u, draft.level));
  if (tops.length > MAX_IMPORT_UNITS) return { ok: false, reason: "too_long", message: TOO_LONG_MESSAGE };

  const skipped: Skipped[] = draft.skipped
    .map((s) => ({ heading: s.heading.trim(), reason: s.reason.trim() }))
    .filter((s) => s.heading.length > 0);
  const granularity: Granularity = leavesOfUnits(tops).every((u) => u.level === "day") ? "day" : "week";
  const book = buildMaterials(draft, skipped);
  const tally = new Tally();
  const ctx: Ctx = { book, skipped, tally, hoursPerWeek, daysPerWeek, granularity };

  const root = layout(makeRoot(tops.map((u, i) => toNode(u, ctx, i))));
  const title = clip(draft.title, 200) ?? (clip(fileName.replace(/\.[^.]+$/, ""), 200) || "Imported plan");

  return {
    ok: true,
    plan: {
      title,
      granularity,
      hoursPerWeek,
      daysPerWeek,
      split: tally.split(),
      materials: book.materials,
      tree: toTreeInput(root),
      kept: draft.kept.map((k) => k.trim()).filter(Boolean),
      skipped,
    },
  };
}

function toUnit(draft: ImportUnitDraft, level: PlanLevel): Unit {
  const below = childLevel(level);
  const children = below && draft.children && draft.children.length > 0 ? draft.children.map((c) => toUnit(c, below)) : null;
  return { level, draft, children };
}

/** A day-only file's days in weeks of `daysPerWeek`, titled "Week N". Each day is kept as written. */
function weeksOfDays(days: ImportUnitDraft[], daysPerWeek: number): Unit[] {
  const weeks: Unit[] = [];
  for (let i = 0; i < days.length; i += daysPerWeek) {
    const run = days.slice(i, i + daysPerWeek);
    const first = i + 1;
    const last = i + run.length;
    weeks.push({
      level: "week",
      draft: {
        title: `Week ${weeks.length + 1}`,
        summary: first === last ? `Day ${first} of your file.` : `Days ${first}–${last} of your file.`,
        budgetHours: null,
        reading: [],
        practice: [],
        children: null,
      },
      children: run.map((d) => ({ level: "day", draft: d, children: null })),
    });
  }
  return weeks;
}

function leavesOfUnits(units: Unit[]): Unit[] {
  return units.flatMap((u) => (u.children ? leavesOfUnits(u.children) : [u]));
}

// ---------------------------------------------------------------------------------------------------------------------
// Materials

interface Book {
  materials: Material[];
  /** The draft's ids (trimmed) to the material each names. */
  byDraftId: Map<string, Material>;
  byId: Map<string, Material>;
  /** Each practice list's labels, by material id, in list order. */
  labels: Map<string, string[]>;
}

function normalTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The materials list: one entry per title (the same title twice is one entry), each with a url no other shares. A
 * practice source the file numbers gets its items, from the material's own list and from every row that names it.
 */
function buildMaterials(draft: Extract<ImportDraft, { kind: "plan" }>, skipped: Skipped[]): Book {
  const byDraftId = new Map<string, Material>();
  const byTitle = new Map<string, Material>();
  const formatOf = new Map<string, PracticeFormat>();
  const labels = new Map<string, string[]>();
  const urls = new Set<string>();
  const materials: Material[] = [];

  for (const m of draft.materials) {
    const title = clip(m.title, 300);
    const draftId = m.id.trim();
    if (!title) continue;
    const same = byTitle.get(normalTitle(title));
    if (same) {
      if (draftId) byDraftId.set(draftId, same);
      if (!formatOf.has(same.id) && m.practiceFormat) formatOf.set(same.id, toFormat(m.practiceFormat));
      addLabels(labels, same.id, m.items);
      continue;
    }
    if (materials.length >= MAX_MATERIALS) {
      skipped.push({ heading: title, reason: `The materials list holds at most ${MAX_MATERIALS} entries.` });
      continue;
    }
    const url = uniqueUrl(title, urls);
    const material: Material = {
      id: shortId(materials.length),
      origin: "import",
      type: "note",
      kind: toKind(m.kind),
      url,
      title,
      author: clip(m.author, 200),
      year: null,
      why: null,
      backbone: false,
      verifiedAt: null,
      fetchedTitle: null,
      recommendedBy: [],
      sig: null,
    };
    materials.push(material);
    byTitle.set(normalTitle(title), material);
    if (draftId) byDraftId.set(draftId, material);
    if (m.practiceFormat) formatOf.set(material.id, toFormat(m.practiceFormat));
    addLabels(labels, material.id, m.items);
  }

  // Rows may name items the material's own list left out: they are the file's items all the same.
  const walk = (units: ImportUnitDraft[]) => {
    for (const unit of units) {
      for (const row of unit.practice) {
        const material = row.id ? byDraftId.get(row.id.trim()) : undefined;
        if (material) addLabels(labels, material.id, row.items);
      }
      if (unit.children) walk(unit.children);
    }
  };
  walk(draft.units);

  const lists = new Map<string, string[]>();
  for (const material of materials) {
    const format = formatOf.get(material.id);
    const items = (labels.get(material.id) ?? []).slice(0, MAX_PRACTICE_ITEMS);
    if (!format || items.length < MIN_PRACTICE_ITEMS) continue;
    const perItemMinutes = PRACTICE_REGISTRY[format].perItemMinutes ?? 10;
    material.practice = {
      format,
      items: items.length,
      perItemMinutes,
      minutes: Math.min(60000, items.length * perItemMinutes),
      answers: false,
      list: { source: "file", url: material.url, items: items.map(toItem) },
    };
    lists.set(material.id, items);
  }
  return { materials, byDraftId, byId: new Map(materials.map((m) => [m.id, m])), labels: lists };
}

function addLabels(labels: Map<string, string[]>, id: string, items: string[] | null | undefined) {
  const list = labels.get(id) ?? [];
  for (const raw of items ?? []) {
    const label = raw.trim();
    if (label && !list.includes(label)) list.push(label);
  }
  labels.set(id, list);
}

function toItem(label: string): PracticeItem {
  return {
    title: clip(label, 300)!,
    number: label.length <= 20 ? label : null,
    group: null,
    difficulty: null,
    url: null,
    solutionUrl: null,
    minutes: null,
  };
}

function toKind(kind: string): MaterialKind {
  const k = kind.trim().toLowerCase();
  return (MATERIAL_KINDS as readonly string[]).includes(k) ? (k as MaterialKind) : "other";
}

function toFormat(format: string): PracticeFormat {
  const f = format.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return (PRACTICE_FORMATS as readonly string[]).includes(f) ? (f as PracticeFormat) : "other";
}

/** `import:<slug>`, unique within the list. A title with no ASCII letters or digits slugs to a hash of itself. */
function uniqueUrl(title: string, taken: Set<string>): string {
  const base = `import:${slug(title)}`;
  let url = base;
  for (let n = 2; taken.has(url); n += 1) url = `${base}-${n}`;
  taken.add(url);
  return url;
}

function slug(title: string): string {
  const ascii = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return ascii || `t-${hash(title)}`;
}

/** FNV-1a over the UTF-16 units, in base 36: short, stable, and different for different titles in practice. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// ---------------------------------------------------------------------------------------------------------------------
// Units

interface Ctx {
  book: Book;
  skipped: Skipped[];
  tally: Tally;
  hoursPerWeek: number;
  daysPerWeek: number;
  granularity: Granularity;
}

/** Strips the "Week 3 ·" numbering the app adds itself; a title that is only the numbering stays as it is. */
function cleanTitle(title: string, level: PlanLevel): string {
  const trimmed = title.trim();
  const stripped = trimmed.replace(new RegExp(`^${level}\\s*\\d+\\s*[·:|.\\-–—]\\s+`, "i"), "").trim();
  return clip(stripped || trimmed, 300) ?? "";
}

function toNode(unit: Unit, ctx: Ctx, index = 0): PlanNode {
  const { level, draft } = unit;
  const title = cleanTitle(draft.title, level) || `${level.charAt(0).toUpperCase()}${level.slice(1)} ${index + 1}`;
  const summary = clip(draft.summary, 2000) ?? title;
  const reading = capRows(draft.reading, title, "readings", ctx.skipped);
  const practice = capRows(draft.practice, title, "practice rows", ctx.skipped);
  const children = unit.children ? unit.children.map((c, i) => toNode(c, ctx, i)) : null;
  const weekBudget = Math.min(500, Math.max(1, Math.round(draft.budgetHours && draft.budgetHours > 0 ? draft.budgetHours : ctx.hoursPerWeek)));

  // A leaf holds rows; a heading (a month, or any unit the file breaks down) holds reservations and its time.
  const leaf = children === null && (level === "day" || level === "week");
  if (leaf) {
    const materials = reading.flatMap((r) => readRef(r, title, ctx));
    let rows = practice.flatMap((p) => practiceRefs(p, ctx));
    if (rows.length > MAX_UNIT_ROWS) {
      ctx.skipped.push({ heading: title, reason: `Only the first ${MAX_UNIT_ROWS} of its ${rows.length} practice items fit one unit.` });
      rows = rows.slice(0, MAX_UNIT_ROWS);
    }
    tallyRows(ctx, materials, rows);
    return makeNode({
      level,
      title,
      summary,
      len: level === "day" ? 1 : ctx.daysPerWeek,
      budgetHours: level === "week" ? weekBudget : null,
      materials,
      practice: rows,
    });
  }

  const covers = reading.flatMap((r) => coverRef(r, title, ctx));
  let practiceCovers = practice.flatMap((p) => practiceCoverRefs(p, ctx));
  if (practiceCovers.length > MAX_UNIT_ROWS) {
    ctx.skipped.push({ heading: title, reason: `Only the first ${MAX_UNIT_ROWS} of its ${practiceCovers.length} practice reservations fit one unit.` });
    practiceCovers = practiceCovers.slice(0, MAX_UNIT_ROWS);
  }
  tallyRows(ctx, covers, practiceCovers);
  const time = unitTime(covers, practiceCovers);
  const hasTime = time.reading > 0 || Object.keys(time.practice).length > 0;
  // A week the file breaks into days is a week split by hand on a week plan: it keeps its budget.
  const splitWeek = level === "week" && ctx.granularity === "week";
  return makeNode({
    level,
    title,
    summary,
    len: children ? children.reduce((sum, c) => sum + c.len, 0) : MONTH_WEEKS * ctx.daysPerWeek,
    budgetHours: splitWeek ? weekBudget : null,
    manualSplit: splitWeek,
    covers,
    practiceCovers,
    ...(children === null || hasTime ? { time } : {}),
    children,
  });
}

/** Counts a unit's final rows toward the split. */
function tallyRows(ctx: Ctx, reading: { minutes?: number | null }[], practice: { format: PracticeFormat; id: string | null; minutes?: number }[]) {
  for (const r of reading) ctx.tally.reading(r.minutes ?? 0);
  for (const p of practice) ctx.tally.practice(p.format, p.minutes ?? 0, p.id ? (ctx.book.byId.get(p.id) ?? null) : null);
}

function capRows<T>(rows: T[], title: string, what: string, skipped: Skipped[]): T[] {
  if (rows.length <= MAX_UNIT_ROWS) return rows;
  skipped.push({ heading: title, reason: `Only the first ${MAX_UNIT_ROWS} of its ${rows.length} ${what} fit one unit.` });
  return rows.slice(0, MAX_UNIT_ROWS);
}

function readMinutes(minutes: number | null): number | null {
  return minutes === null || !Number.isFinite(minutes) ? null : Math.max(0, Math.min(6000, Math.round(minutes)));
}

function readTarget(row: ImportReadingDraft, title: string, ctx: Ctx): Material | null {
  const material = ctx.book.byDraftId.get(row.id.trim()) ?? null;
  if (!material) ctx.skipped.push({ heading: title, reason: `A reading${row.part ? ` (${row.part.trim()})` : ""} names "${row.id}", which is not on the materials list.` });
  return material;
}

function readRef(row: ImportReadingDraft, title: string, ctx: Ctx): MaterialRef[] {
  const material = readTarget(row, title, ctx);
  if (!material) return [];
  const minutes = readMinutes(row.minutes);
  return [{ id: material.id, tier: "must", activity: "read", chapter: null, note: clip(row.part, 300), minutes }];
}

function coverRef(row: ImportReadingDraft, title: string, ctx: Ctx): CoverRef[] {
  const material = readTarget(row, title, ctx);
  if (!material) return [];
  const minutes = readMinutes(row.minutes);
  return [{ id: material.id, note: clip(row.part, 300), chapter: null, activity: "read", tier: "must", minutes }];
}

function rowMinutes(minutes: number): number {
  return Math.max(1, Math.min(600, Math.round(minutes)));
}

/** A practice row as the file writes it: its format, its source and the positions of the items it names. */
function readRow(row: ImportPracticeDraft, ctx: Ctx) {
  const format = toFormat(row.format);
  const spec = PRACTICE_REGISTRY[format];
  const material = row.id ? (ctx.book.byDraftId.get(row.id.trim()) ?? null) : null;
  const list = material ? ctx.book.labels.get(material.id) : undefined;
  const positions = list
    ? [...new Set((row.items ?? []).map((l) => list.indexOf(l.trim()) + 1).filter((p) => p > 0))]
    : [];
  const task = clip(row.task, 300) ?? clip(row.done, 300) ?? spec.label;
  const done = clip(row.done, 300) ?? spec.doneWhen;
  const given = row.minutes !== null && Number.isFinite(row.minutes) && row.minutes > 0 ? row.minutes : null;
  return { format, material, list: list ?? [], positions, task, done, given, perItem: spec.perItemMinutes ?? 10, block: spec.fixedMinutes ?? DEFAULT_ROW_MINUTES };
}

/** One row per item the row names, its minutes divided evenly; else one row. Every one is the learner's own. */
function practiceRefs(draft: ImportPracticeDraft, ctx: Ctx): PracticeRef[] {
  const row = readRow(draft, ctx);
  if (row.material && row.positions.length > 0) {
    const minutes = row.given === null ? row.positions.map(() => row.perItem) : shareOut(Math.round(row.given), row.positions.map(() => 1));
    return row.positions.map((p, i) => {
      const m = rowMinutes(minutes[i]);
      return {
        format: row.format,
        id: row.material!.id,
        task: clip(`${row.task} · ${row.list[p - 1]}`, 300)!,
        done: row.done,
        minutes: m,
        generated: false,
        itemFrom: p,
        itemTo: p,
        imported: true,
      };
    });
  }
  const m = rowMinutes(row.given ?? row.block);
  return [{ format: row.format, id: row.material?.id ?? null, task: row.task, done: row.done, minutes: m, generated: false, imported: true }];
}

/** A heading's reservations: one per run of consecutive items the row names, else one for the row. */
function practiceCoverRefs(draft: ImportPracticeDraft, ctx: Ctx): PracticeCover[] {
  const row = readRow(draft, ctx);
  if (row.material && row.positions.length > 0) {
    const runs = numberRuns(row.positions);
    const total = row.given === null ? row.positions.length * row.perItem : Math.round(row.given);
    const minutes = shareOut(total, runs.map(([a, b]) => b - a + 1));
    return runs.map(([from, to], i) => {
      const m = rowMinutes(minutes[i]);
      return { format: row.format, id: row.material!.id, note: null, task: row.task, minutes: m, itemFrom: from, itemTo: to, imported: true };
    });
  }
  const m = rowMinutes(row.given ?? row.block);
  return [{ format: row.format, id: row.material?.id ?? null, note: null, task: row.task, minutes: m, imported: true }];
}

function unitTime(covers: CoverRef[], practiceCovers: PracticeCover[]): UnitTime {
  const practice: Partial<Record<PracticeFormat, number>> = {};
  for (const c of practiceCovers) practice[c.format] = Math.min(MAX_UNIT_MINUTES, (practice[c.format] ?? 0) + (c.minutes ?? 0));
  return { reading: Math.min(MAX_UNIT_MINUTES, covers.reduce((sum, c) => sum + (c.minutes ?? 0), 0)), practice };
}

// ---------------------------------------------------------------------------------------------------------------------
// Split

/** Minutes the plan gives reading and each practice format, in the order the formats first appear. */
class Tally {
  private readingMinutes = 0;
  private formats = new Map<PracticeFormat, { minutes: number; sources: string[] }>();

  reading(minutes: number) {
    this.readingMinutes += minutes;
  }

  practice(format: PracticeFormat, minutes: number, source: Material | null) {
    const entry = this.formats.get(format) ?? { minutes: 0, sources: [] };
    entry.minutes += minutes;
    if (source && !entry.sources.includes(source.title)) entry.sources.push(source.title);
    this.formats.set(format, entry);
  }

  /** The reading share from the file's minutes, and every format the file uses with its share of the practice time. */
  split(): PlanSplit {
    const entries = [...this.formats.entries()];
    const practiceMinutes = entries.reduce((sum, [, e]) => sum + e.minutes, 0);
    const total = this.readingMinutes + practiceMinutes;
    if (entries.length === 0 || practiceMinutes === 0) {
      return { readingShare: 100, practice: IMPORT_SPLIT_PRACTICE, reason: SPLIT_FROM_FILE, formats: [] };
    }
    // Practice is in the file, so the share stays below 100: a split at 100% reading spends nothing on its picks.
    const readingShare = Math.min(99, Math.round((this.readingMinutes / total) * 100));
    const shares = sharesOf(entries.map(([, e]) => e.minutes));
    const formats: PracticePick[] = entries.map(([format, e], i) => ({
      format,
      share: shares[i],
      focus: clip(e.sources.join(", "), 160) ?? `${PRACTICE_REGISTRY[format].label} tasks from your file`,
      reason: SPLIT_FROM_FILE,
    }));
    return { readingShare, practice: IMPORT_SPLIT_PRACTICE, formats, reason: SPLIT_FROM_FILE };
  }
}

/** Percent shares of `minutes` summing to exactly 100, each at least 1 (taken from the largest). */
function sharesOf(minutes: number[]): number[] {
  const shares = shareOut(100, minutes.map((m) => Math.round(m)));
  for (let i = 0; i < shares.length; i += 1) {
    if (shares[i] >= 1) continue;
    const largest = shares.indexOf(Math.max(...shares));
    shares[largest] -= 1 - shares[i];
    shares[i] = 1;
  }
  return shares;
}
