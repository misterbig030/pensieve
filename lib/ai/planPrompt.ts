import {
  aliasMaterials,
  draftedSplit,
  formatAliases,
  itemAliases,
  itemRun,
  pickSources,
  placedMinutes,
  planBlockBudgets,
  practiceBudgets,
  type MaterialAliases,
  type PickSources,
  type ResolvedAlias,
} from "@/lib/materials";
import { PRACTICE_REGISTRY, formatRuns, isBlockFormat, itemMinutes, itemPositions, listGroups, type PracticeFormat, type PracticeGenerated } from "@/lib/practice";
import {
  budgetFor,
  capitalize,
  childLevel,
  findNode,
  fullLabelOf,
  labelOf,
  parentOf,
  spanOf,
  walk,
  weeksOf,
  type Granularity,
  type PlanLevel,
  type PlanNode,
} from "@/lib/planTree";
import { hostOf, type ChapterList, type CoverRef, type Material, type MaterialPractice, type MaterialRef, type PracticeCover, type PracticeList, type PracticeRef, type RefActivity } from "@/lib/schemas/material";
import { dayMinutes, isAllReading, practiceLabelOf, weeksLabel, type PlanSplit } from "@/lib/studyTime";

export interface PlanPromptContext {
  topic: string;
  instructions?: string;
  /** The plan's materials list: the learner's sources and what research verified. */
  materials: Material[];
  granularity: Granularity;
  /** Hours a week the learner can give. Left out, prompts say nothing about time and budgets assume six. */
  hoursPerWeek?: number;
  /** The learner's usual study days a week: weeks not split yet have this many days. */
  daysPerWeek: number;
  /** How the plan divides the learner's time, once decided. */
  split?: PlanSplit | null;
}

export interface RenderTreeOptions {
  /** The learner's usual study days a week, to count the weeks of a month not planned yet. */
  daysPerWeek: number;
  /** Node id → short ref shown as `[n3]`, for prompts whose answer must echo refs. */
  refs?: Map<string, string>;
  /** Days on or before this are completed and locked. */
  lockBefore?: number;
  /** Prefix this node's line with `>>` so the model knows which one is meant. */
  markId?: string;
  /** Show each node's material references under these aliases. Omitted, references are not shown. */
  aliases?: MaterialAliases;
}

function refNote(note: string | null): string {
  return note ? ` (${note})` : "";
}

type RefLike = { id: string; chapter?: number | null; activity?: RefActivity; note?: string | null };
const activityOf = (r: RefLike): RefActivity => r.activity ?? "read";

/** "M1.1–M1.4, M3 (lectures 3–4)": runs of consecutive chapters collapse; a whole resource keeps its note. */
export function describeRefs(refs: RefLike[], aliases: MaterialAliases): string {
  const out: string[] = [];
  let run: ResolvedAlias[] = [];
  const flush = () => {
    if (run.length > 0) out.push(formatAliases(run, aliases));
    run = [];
  };
  for (const r of refs) {
    if (r.chapter) run.push({ id: r.id, chapter: r.chapter });
    else {
      flush();
      out.push(`${aliases.alias(r.id)}${refNote(r.note ?? null)}`);
    }
  }
  flush();
  return out.join(", ");
}

type PracticeLike = { id: string | null; task?: string; minutes?: number; note?: string | null; generated?: boolean; itemFrom?: number | null; itemTo?: number | null };

/**
 * One practice row or reservation without its format: "M2 40 min: Arrays 1–6", "generated 15 min: Six questions",
 * "M2 (Arrays & Hashing)"; an item row "M4.12 25 min: Group Anagrams", a run "M4 items 1–9". A row the model wrote says
 * so; one whose source is not in the list is left out (null).
 */
function practiceItem(r: PracticeLike, aliases: MaterialAliases): string | null {
  const base = r.id === null ? null : aliases.alias(r.id);
  if (base === undefined) return null;
  const alias = base !== null && r.id !== null && r.itemFrom && r.itemTo ? itemRun(aliases, r.id, r.itemFrom, r.itemTo) : base;
  const generated = r.id === null || r.generated;
  const who = [alias, generated ? "generated" : null].filter(Boolean).join(" ");
  return `${who}${r.minutes ? ` ${r.minutes} min` : ""}${r.task ? `: ${r.task}` : ""}${refNote(r.note ?? null)}`;
}

/** "Problems M2 40 min: Arrays 1–6; Recall M1 generated 15 min: Six questions": rows of any formats, each named by its format. */
function describePractice(rows: (PracticeRef | PracticeCover)[], aliases: MaterialAliases): string {
  return rows
    .map((r) => {
      const item = practiceItem(r, aliases);
      return item === null ? null : `${PRACTICE_REGISTRY[r.format].label} ${item}`;
    })
    .filter((s): s is string => s !== null)
    .join("; ");
}

/**
 * "covers M1.1–M1.4, M3" for a heading; "reads M1.2 must 35 min (Post-Training; Sampling); M3 should 79 min" for a leaf,
 * then the practice it reserves ("practice covers Problems M2 (Arrays & Hashing)") or does ("practises Problems M2 40
 * min: Arrays 1–6"). Review rows, which only plans saved before reviews were withdrawn from the planner carry, are not
 * shown: the model is not to imitate them, and they reserve nothing for reading.
 */
export function renderRefs(node: Pick<PlanNode, "covers" | "materials" | "practice" | "practiceCovers">, aliases: MaterialAliases): string {
  const parts: string[] = [];
  const covers = (node.covers ?? []).filter((r: CoverRef) => aliases.alias(r.id) && activityOf(r) === "read");
  const reads = (node.materials ?? []).filter((r: MaterialRef) => aliases.alias(r.id) && activityOf(r) === "read");
  const row = (r: MaterialRef) => `${aliases.alias(r.id, r.chapter)} ${r.tier}${r.minutes !== null ? ` ${r.minutes} min` : ""}${refNote(r.note)}`;
  if (covers.length > 0) parts.push(`covers ${describeRefs(covers, aliases)}`);
  if (reads.length > 0) parts.push(`reads ${reads.map(row).join("; ")}`);
  const practiceCovers = describePractice(node.practiceCovers ?? [], aliases);
  const practice = describePractice(node.practice ?? [], aliases);
  if (practiceCovers) parts.push(`practice covers ${practiceCovers}`);
  if (practice) parts.push(`practises ${practice}`);
  return parts.join(" · ");
}

/** Renders the tree as indented text the model can read: labels, spans, titles, summaries, done/locked marks. */
export function renderTree(root: PlanNode, opts: RenderTreeOptions): string {
  const lines: string[] = [];
  walk(root, (node, parent) => {
    if (node.id === root.id) return;
    const depth = depthOf(root, node);
    const indent = "  ".repeat(depth);
    const ref = opts.refs?.get(node.id);
    const marks: string[] = [];
    if (node.status === "completed") marks.push("done");
    else if (opts.lockBefore && node.end <= opts.lockBefore) marks.push("locked");
    if (node.children === null && node.level !== "day" && node.budgetHours !== null) marks.push(`${node.level}-sized unit, logged as sessions`);
    else if (node.children === null && childLevel(node.level)) marks.push("not yet planned in detail");
    const mark = marks.length > 0 ? ` [${marks.join("; ")}]` : "";
    const prefix = opts.markId === node.id ? ">> " : "";
    const label = labelOf(root, node);
    const span = node.level === "day" ? "" : ` (${spanOf(root, node, opts.daysPerWeek)})`;
    const refs = opts.aliases ? renderRefs(node, opts.aliases) : "";
    lines.push(`${indent}${prefix}${label}${ref ? ` [${ref}]` : ""}${span}: "${node.title}" — ${node.summary}${mark}${refs ? ` {${refs}}` : ""}`);
    void parent;
  });
  return lines.join("\n");
}

function depthOf(root: PlanNode, node: PlanNode): number {
  let depth = 0;
  let cursor: PlanNode | null = node;
  const parentMap = new Map<string, PlanNode | null>();
  walk(root, (n, p) => parentMap.set(n.id, p));
  while (cursor && parentMap.get(cursor.id) && parentMap.get(cursor.id)!.id !== root.id) {
    depth += 1;
    cursor = parentMap.get(cursor.id)!;
  }
  return depth;
}

/** Assigns short refs (`n1`, `n2`, …) to every node in plan order. */
export function assignRefs(root: PlanNode): Map<string, string> {
  const refs = new Map<string, string>();
  let i = 0;
  walk(root, (node) => {
    if (node.id === root.id) return;
    i += 1;
    refs.set(node.id, `n${i}`);
  });
  return refs;
}

/**
 * " · ch. 1, 7–9, about 5 h (estimated)" for a sized material; empty when its size is not known. A material with units
 * has a budget instead, which the outline reserves its units toward: " · budget about 50 min for building blocks".
 */
function sizeNote(m: Material): string {
  if (m.toc && m.minutes) return ` · budget about ${formatMinutes(m.minutes)}${m.uses ? ` for ${m.uses}` : ""}`;
  if (!m.minutes) return m.uses ? ` · ${m.uses}` : "";
  return ` · ${m.uses ? `${m.uses}, ` : ""}about ${formatMinutes(m.minutes)}${m.minutesBasis === "estimated" ? " (estimated)" : ""}`;
}

export interface RenderMaterialsOptions {
  /** Print section headings under the backbone's chapters. */
  sections?: boolean;
}

/**
 * The indented chapter lines under a book, then the source line: `  M1.5 ch. 5 "Prompt Engineering" · pp. 453–540 ·
 * about 2 h — Introduction to Prompting; …`. The alias prefix appears when the book's alias is given; the number, the
 * pages, the size and the sections each appear only when known (and, for sections, asked for). Units that have groups
 * get a group line before the first unit of each (`  building blocks:`); a source that is not a book names them units.
 */
export function renderChapters(toc: ChapterList, options: { sections: boolean; alias?: string; book?: boolean }): string[] {
  let group: string | null = null;
  const lines = toc.chapters.flatMap((c, i) => {
    const parts = [`${options.alias ? `${options.alias}.${i + 1} ` : ""}${c.n !== null ? `ch. ${c.n} ` : ""}"${c.title}"`];
    if (toc.printPages && c.page !== null) {
      // A chapter whose successor was cut carries its own end; otherwise its span ends where the next one starts.
      const next = c.end !== undefined ? c.end : i + 1 < toc.chapters.length ? toc.chapters[i + 1].page : toc.end;
      parts.push(next !== null && next > c.page ? `pp. ${c.page}–${next - 1}` : `p. ${c.page}`);
    }
    if (c.minutes !== null) parts.push(`about ${formatMinutes(c.minutes)}`);
    const tail = options.sections && c.sections.length > 0 ? ` — ${c.sections.join("; ")}` : "";
    const heading = c.group && c.group !== group ? [`  ${c.group}:`] : [];
    group = c.group ?? null;
    return [...heading, `  ${parts.join(" · ")}${tail}`];
  });
  lines.push(`  (${options.book === false ? "units" : "chapters"} from ${toc.source === "catalogue" ? "Open Library" : (hostOf(toc.url) ?? "a page")})`);
  return lines;
}

/** What a kind of practice item is called in a count; formats without a noun have no count. */
const ITEM_NOUN: Partial<Record<PracticeFormat, string>> = { "problem-set": "problem", recall: "question", lab: "step" };

/** `practice: Problems · 75 of 150 problems · about 10 min each · answers`: the format, how much of it, the time per item and whether it checks the learner. */
export function practiceTag(p: MaterialPractice): string {
  const noun = ITEM_NOUN[p.format];
  const count = noun && p.items ? `${p.totalItems && p.totalItems > p.items ? `${p.items} of ${p.totalItems}` : p.items} ${noun}${(p.totalItems ?? p.items) === 1 ? "" : "s"}` : null;
  return ["practice: " + PRACTICE_REGISTRY[p.format].label, count, p.perItemMinutes ? `about ${p.perItemMinutes} min each` : null, p.answers ? "answers" : null].filter(Boolean).join(" · ");
}

/** How a format's time is counted: per item (`Problems is sized per problem, about 10 min each.`) or as one fixed block; none for a format that is neither. */
export function sizingSentence(format: PracticeFormat): string | null {
  const spec = PRACTICE_REGISTRY[format];
  if (spec.perItemMinutes) return `${spec.label} is sized per ${ITEM_NOUN[format] ?? "item"}, about ${spec.perItemMinutes} min each.`;
  if (spec.fixedMinutes) return `${spec.label} is one block of about ${spec.fixedMinutes} min.`;
  return null;
}

/**
 * One line per material: `M1 [book · backbone] "AI Engineering" — Chip Huyen, 2024 · about 22 h. Why: …`, followed by
 * its chapter lines when it has a list, each a resource of its own (`M1.3`), in which case the book line says so. A
 * practice source is tagged with the format it serves (`practice: Problems · 150 problems · about 10 min each · answers`).
 */
export function renderMaterials(materials: Material[], aliases: MaterialAliases = aliasMaterials(materials), options: RenderMaterialsOptions = {}): string {
  return materials
    .flatMap((m) => {
      // A listed source is timed item by item, so its tag gives no single per-item time.
      const practice = m.practice ? practiceTag(m.practice.list ? { ...m.practice, perItemMinutes: null } : m.practice) : null;
      const tags = [m.kind, m.backbone ? "backbone" : null, practice, m.origin === "learner" ? "the learner's own" : null].filter(Boolean).join(" · ");
      const byline = [m.author, m.year].filter(Boolean).join(", ");
      const where = m.type === "note" || m.type === "file" ? "" : ` <${m.url}>`;
      const alias = aliases.alias(m.id);
      const book = m.kind === "book";
      const resource = m.toc ? `${m.why ? "" : "."} Refer to its ${book ? "chapters" : "units"} by id; ${alias} itself is not a resource.` : "";
      const line = `${alias} [${tags}] "${m.title}"${byline ? ` — ${byline}` : ""}${where}${sizeNote(m)}${m.why ? `. ${m.why}` : ""}${resource}`;
      const list = m.practice?.list ? [renderItemGroups(m.practice.format, m.practice.list, aliases, m)] : [];
      return m.toc ? [line, ...renderChapters(m.toc, { sections: !!options.sections && m.backbone, alias, book }), ...list] : [line, ...list];
    })
    .join("\n");
}

/**
 * A listed practice source's groups on one line under it, by position, never by title: `  M4 items 1–9 Arrays & Hashing
 * (3.3 h); 10–14 Two Pointers (2.1 h)`. A group is every item of that name, so one that comes back shows each run. A source
 * that also has chapters says what its items are called: `  M4 items, as M4.i1–M4.i21: 1–9 Arrays & Hashing (3.3 h); …`.
 */
function renderItemGroups(format: PracticeFormat, list: PracticeList, aliases: MaterialAliases, m: Pick<Material, "id" | "toc">): string {
  const alias = aliases.alias(m.id)!;
  const groups = listGroups(list.items).map(({ name, positions, items }) => {
    const minutes = items.reduce((sum, item) => sum + itemMinutes(format, item), 0);
    return `${formatRuns(positions)} ${name ?? "no group"} (${formatMinutes(minutes)})`;
  });
  // A source with chapters names its items apart from them (`M4.i1`), so the line says how.
  const named = m.toc ? `, as ${itemAliases(aliases, m.id, list.items.map((_, i) => i + 1))}:` : "";
  return `  ${alias} items${named} ${groups.join("; ")}`;
}

/** `M4.12 49. Group Anagrams · Arrays & Hashing · medium · 25 min`: one listed item as a leaf takes it. */
function itemLine(format: PracticeFormat, list: PracticeList, aliases: MaterialAliases, id: string, position: number): string {
  const item = list.items[position - 1];
  const title = `${item.number ? `${item.number}. ` : ""}${item.title}`;
  return `  ${aliases.alias(id, { item: position })} ${[title, item.group, item.difficulty, `${itemMinutes(format, item)} min`].filter(Boolean).join(" · ")}`;
}

function contextLines(ctx: PlanPromptContext, options: RenderMaterialsOptions = {}): string[] {
  const parts: string[] = [];
  parts.push(`Topic: ${ctx.topic}`);
  if (ctx.instructions?.trim()) parts.push(`The learner's focus & instructions: "${ctx.instructions.trim()}"`);
  parts.push(...timeLines(ctx));
  if (ctx.materials.length > 0) {
    parts.push(`The plan's materials. The learner's own are always part of it; the rest were found and checked by research. Refer to them by id:`);
    parts.push(renderMaterials(ctx.materials, undefined, options));
  }
  return parts;
}

/** What the prompt says about the learner's time: the weekly hours and days, and the plan's split once it is decided. */
function timeLines(ctx: Pick<PlanPromptContext, "hoursPerWeek" | "daysPerWeek" | "split" | "materials">): string[] {
  const lines: string[] = [];
  const days = `${ctx.daysPerWeek} study day${ctx.daysPerWeek === 1 ? "" : "s"} a week`;
  if (ctx.hoursPerWeek !== undefined) lines.push(`The learner's time: about ${ctx.hoursPerWeek} hour${ctx.hoursPerWeek === 1 ? "" : "s"} a week, over ${days}. This setting is what the plan is budgeted from, whatever the instructions say about time.`);
  else lines.push(`The learner studies ${ctx.daysPerWeek} day${ctx.daysPerWeek === 1 ? "" : "s"} a week.`);
  if (ctx.split) {
    // As drafted: a pick with no source is reading, so the line names the picks the units actually get.
    const split = draftedSplit(ctx.split, ctx.materials);
    lines.push(
      isAllReading(split)
        ? "How this plan spends that time: all of it reading or watching the materials."
        : `How this plan spends that time: about ${split.readingShare}% reading or watching the materials, the rest on ${practiceLabelOf(split)}.`,
    );
  }
  return lines;
}

const UNIT_NOUN: Record<PlanLevel, string> = { month: "month", week: "week", day: "day" };

export interface UnitsPromptInput extends PlanPromptContext {
  /** The level of the units being written. */
  level: PlanLevel;
  /** Span of each unit in study days, in order. */
  spans: number[];
  /** Whole plan length in weeks. */
  weeks: number;
  /** When expanding, the tree so far and the node being planned. */
  tree?: PlanNode;
  parentId?: string;
  /** True when the units are the finest level the learner will work at (they get content and check-ins). */
  unitsAreLeaves: boolean;
}

/** Asks for titles and summaries for exactly `spans.length` units whose spans the server already decided. */
export function buildUnitsPrompt(input: UnitsPromptInput): string {
  const parts: string[] = [];
  const noun = UNIT_NOUN[input.level];
  const n = input.spans.length;
  const aliases = aliasMaterials(input.materials);
  const hasMaterials = input.materials.length > 0;
  parts.push(`You are designing a self-study curriculum, one unit at a time.`);
  parts.push(...contextLines(input, { sections: true }));
  parts.push(`The whole plan is ${weeksLabel(input.weeks)} long. Each week's days are numbered from Day 1.`);

  if (input.tree && input.parentId) {
    parts.push(`Here is the plan so far. Lines marked done are behind the learner; use what they covered to plan what comes next.${hasMaterials ? " Braces show the materials each unit reserves or reads." : ""}`);
    parts.push(renderTree(input.tree, { daysPerWeek: input.daysPerWeek, markId: input.parentId, aliases: hasMaterials ? aliases : undefined }));
    parts.push(`Plan the ${noun}s inside the unit marked ">>" in detail. Its ${n} ${noun}s cover, in order:`);
  } else {
    parts.push(`Split the plan into ${n} ${noun}${n === 1 ? "" : "s"}, easiest and most foundational first, hardest and most applied last. They cover, in order:`);
  }

  // Days are the days of one week, so the week's day count is the number of units asked for.
  const daysInWeek = input.level === "day" ? n : input.daysPerWeek;
  const picks = pickSources(input.split, input.materials).filter((p) => p.assignable);
  // A week leaf holds its whole week's practice, so its line says each per-item pick's share of it; a block format is
  // budgeted over the plan, which the practice rules state.
  const weekMinutes = weekBudgetsOf(input).practice;
  const perItem = picks.filter((p) => !isBlockFormat(p.pick.format));
  const weekPractice =
    input.unitsAreLeaves && input.level !== "day" && perItem.length > 0
      ? `; practice: ${perItem.map((p) => `${PRACTICE_REGISTRY[p.pick.format].label} ${formatMinutes(weekMinutes[p.pick.format] ?? 0)}`).join(", ")}`
      : "";
  // A week leaf's must-reading is the week's reading budget, as the practice rules and the checks have it: the one
  // place the prompt states it.
  const weekReading = Math.round(weekBudgetsOf(input).reading / 5) * 5;
  input.spans.forEach((len, i) => {
    const minutes = input.unitsAreLeaves ? leafBudgetMinutes(input.level, daysInWeek, input.hoursPerWeek) : null;
    // A day's must-reading is budgeted over its week (the rules say how much), so its line gives only its total.
    const must = minutes === null || !hasMaterials || input.level === "day" ? "" : `, so about ${formatMinutes(weekReading)} of must-reading`;
    const budget = (hasMaterials || picks.length > 0) && minutes !== null ? ` — budget about ${formatMinutes(minutes)}${must}${weekPractice}` : "";
    parts.push(`${i + 1}. ${unitLine(input.level, i, len, input.daysPerWeek)}${budget}`);
  });

  if (input.unitsAreLeaves) {
    parts.push(
      input.level === "day"
        ? input.hoursPerWeek === undefined
          ? `Each day is one focused lesson of roughly 45–60 minutes.`
          : `Each day is one focused session of about ${formatMinutes(dayMinutes(input.hoursPerWeek, daysInWeek))}.`
        : `Each ${noun} is a goal the learner works toward across several sessions of their own choosing; describe the whole ${noun}'s ground, not a day-by-day list.`,
    );
  } else {
    parts.push(`Each ${noun} is a heading that will be planned in detail later, when the learner reaches it. Make the headings distinct and progressive.`);
  }
  parts.push(
    `Return exactly ${n} units in that order. Title: a short noun phrase (at most 8 words) with no "Week 1:" or "Day 3:" prefix. Summary: one sentence on what it covers and why it comes here.`,
  );
  if (hasMaterials) parts.push(input.unitsAreLeaves ? leafMaterialRules(input, aliases) : headingMaterialRules(input, aliases));
  const practice = input.unitsAreLeaves ? leafPracticeRules(input, aliases) : headingPracticeRules(input, aliases);
  if (practice) parts.push(practice);
  return parts.join("\n");
}

/** A week's reading and per-pick practice minutes, with a pick that can't be assigned given back to reading: what the checks hold the week to. */
function weekBudgetsOf(input: UnitsPromptInput) {
  return practiceBudgets(input.split, budgetFor(1, input.hoursPerWeek) * 60, input.materials);
}

/** How a format's rows may be written without a source, as an instruction; null when they never may. */
const WRITE_YOURSELF: Record<PracticeGenerated, string | null> = {
  never: null,
  "from-reading": 'write the questions yourself from that unit\'s own reading, with id set to a resource the unit reads (an id from its "materials"); the reading holds the answers.',
  "with-rubric": "write one prompt yourself (leave id out), with a rubric in done: what a strong answer covers.",
  milestones: "write one milestone per unit of a build the plan names (leave id out), with done saying what runs or exists.",
  "interview-only": "write a mock yourself (leave id out) only for an interview, with the prompt in task and a rubric in done; never for an exam.",
  "from-programme": "write a session yourself (leave id out) only from a programme in the list or the unit's own reading.",
};

/** `Problems (format "problem-set")`: a pick as the practice rules name it. */
function pickName(format: PracticeFormat): string {
  return `${PRACTICE_REGISTRY[format].label} (format "${format}")`;
}

/** The parent's practice reservation of one format, when the units are planned inside a heading that has one. */
function reservedPractice(input: UnitsPromptInput, format: PracticeFormat): PracticeCover[] {
  const parent = input.tree && input.parentId ? findNode(input.tree, input.parentId) : null;
  return (parent?.practiceCovers ?? []).filter((c) => c.format === format);
}

/** The units outside the line of the heading being planned: every node but the root, the parent and its ancestors. */
function otherUnits(input: UnitsPromptInput): PlanNode[] {
  const parent = input.tree && input.parentId ? findNode(input.tree, input.parentId) : null;
  if (!input.tree || !parent) return [];
  const skip = new Set<string>([input.tree.id, parent.id]);
  for (let p = parentOf(input.tree, parent.id); p; p = parentOf(input.tree, p.id)) skip.add(p.id);
  const out: PlanNode[] = [];
  walk(input.tree, (n) => {
    if (!skip.has(n.id)) out.push(n);
  });
  return out;
}

/** "M4.3", "M4 items 1–3, 7": positions of a listed source. */
function positionsText(aliases: MaterialAliases, id: string, positions: number[]): string {
  return positions.length === 1 ? aliases.alias(id, { item: positions[0] })! : `${aliases.alias(id)} items ${formatRuns(positions)}`;
}

/**
 * "Other units have: M2 (Two Pointers) in Month 2." for one format: what the rest of the plan reserves or does of its
 * sources. A unit's items of a listed source are summed up as positions ("M4 items 1–3, 7").
 */
function practiceHeld(input: UnitsPromptInput, aliases: MaterialAliases, format: PracticeFormat): string {
  const held: string[] = [];
  for (const n of otherUnits(input)) {
    const items = (n.practiceCovers ?? []).filter((r) => r.format === format && r.id !== null).map((r) => practiceItem(r, aliases));
    const done = new Map<string, number[]>();
    for (const r of (n.practice ?? []).filter((r) => r.format === format && r.id !== null)) {
      if (r.itemFrom) done.set(r.id!, [...(done.get(r.id!) ?? []), r.itemFrom]);
      else items.push(practiceItem(r, aliases));
    }
    for (const [id, positions] of done) {
      if (aliases.alias(id)) items.push(positionsText(aliases, id, positions));
    }
    const named = items.filter((s): s is string => s !== null);
    if (named.length > 0) held.push(`${named.join("; ")} in ${fullLabelOf(input.tree!, n)}`);
  }
  return held.length > 0 ? ` Other units have: ${held.join("; ")}.` : "";
}

/**
 * Whether a heading anywhere in the plan reserves this source for this format. A week split by hand is left out: its
 * reservation is only what it did itself, which binds its own days.
 */
function reservedSomewhere(input: UnitsPromptInput, format: PracticeFormat, id: string): boolean {
  let found = false;
  if (input.tree) {
    walk(input.tree, (n) => {
      if (!n.manualSplit && (n.practiceCovers ?? []).some((c) => c.format === format && c.id === id)) found = true;
    });
  }
  return found;
}

/**
 * The sources a pick's units may take when their parent reserved none of that format: every source at the top level, and
 * below it those no heading reserves (a source reserved anywhere is used only where it is reserved).
 */
function offeredSources(input: UnitsPromptInput, { pick, sources }: PickSources): string[] {
  const parent = input.tree && input.parentId ? findNode(input.tree, input.parentId) : null;
  return parent ? sources.filter((id) => !reservedSomewhere(input, pick.format, id)) : sources;
}

/** A listed source's list, when it has one. */
function listOf(input: UnitsPromptInput, id: string | null): PracticeList | null {
  return input.materials.find((m) => m.id === id)?.practice?.list ?? null;
}

/** The positions of a listed source a reservation holds: its runs, or the whole list for a reservation without one. */
function reservedPositions(covers: PracticeCover[], list: PracticeList): number[] {
  const runs = covers.flatMap(itemPositions);
  const all = covers.some((c) => itemPositions(c).length === 0);
  return all ? list.items.map((_, i) => i + 1) : [...new Set(runs)].sort((a, b) => a - b);
}

/** Items of a source that units outside this one already did: none of them is the units' to take. */
function takenPositions(input: UnitsPromptInput, id: string): Set<number> {
  const out = new Set<number>();
  for (const n of otherUnits(input)) for (const r of n.practice ?? []) if (r.id === id && r.itemFrom) out.add(r.itemFrom);
  return out;
}

/** Where one pick's rows come from at a leaf level, and the item lines of a listed source, one per item still to do. */
function leafPickSources(input: UnitsPromptInput, aliases: MaterialAliases, p: PickSources): { text: string; items: string[] } {
  const { pick, sources } = p;
  const spec = PRACTICE_REGISTRY[pick.format];
  const write = WRITE_YOURSELF[spec.generated];
  const rule = write === null ? "Every row names one of them; never write rows of this format yourself." : `When none fits, ${write}`;
  const itemsOf = (id: string, list: PracticeList, positions: number[]) => {
    const taken = takenPositions(input, id);
    return positions.filter((n) => !taken.has(n)).map((n) => itemLine(pick.format, list, aliases, id, n));
  };
  const reserved = reservedPractice(input, pick.format).filter((c) => c.id === null || aliases.alias(c.id) !== undefined);
  if (reserved.length > 0) {
    const parts: string[] = [];
    const items: string[] = [];
    const listedIds = [...new Set(reserved.filter((c) => listOf(input, c.id)).map((c) => c.id!))];
    for (const c of reserved.filter((c) => !listOf(input, c.id))) {
      const item = practiceItem(c, aliases);
      if (item !== null) parts.push(item);
    }
    for (const id of listedIds) {
      const list = listOf(input, id)!;
      const positions = reservedPositions(reserved.filter((c) => c.id === id), list);
      parts.push(positionsText(aliases, id, positions));
      items.push(...itemsOf(id, list, positions));
    }
    const listed = listedIds.length > 0 ? "; the items not yet done are below, one row each" : "";
    return { text: `Reserved for this unit: ${parts.join("; ")}${listed}.${practiceHeld(input, aliases, pick.format)} ${rule}`, items };
  }
  const offered = offeredSources(input, p);
  if (offered.length === 0 && sources.length > 0) {
    const none = write === null ? `write no ${spec.label} rows.` : `take none of them; ${write}`;
    return { text: `This unit reserves no ${spec.label} source, and every one is reserved by other units: ${none}`, items: [] };
  }
  if (offered.length === 0) return { text: `No source in the list: ${write}`, items: [] };
  const listedIds = offered.filter((id) => listOf(input, id));
  const items = listedIds.flatMap((id) => {
    const list = listOf(input, id)!;
    return itemsOf(id, list, list.items.map((_, i) => i + 1));
  });
  const listed = listedIds.length > 0 ? ` ${listedIds.map((id) => `${aliases.alias(id)}'s`).join(" and ")} items not yet done are below, in list order: take them in order, one row each.` : "";
  return { text: `Sources: ${offered.map((id) => aliases.alias(id)).join(", ")}.${listed}${practiceHeld(input, aliases, pick.format)} ${rule}`, items };
}

/** When a picked format's source is cut to part of its items: share out only that part. Null when none is cut. */
function cutSourceRule(picks: PickSources[], materials: Material[]): string | null {
  const ids = new Set(picks.flatMap((p) => p.sources));
  const cut = materials.some((m) => ids.has(m.id) && m.practice?.items && m.practice.totalItems && m.practice.totalItems > m.practice.items);
  return cut ? 'A source the plan uses only part of says so in its tag ("N of M problems"): share out only the kept items, never past them.' : null;
}

/**
 * The practice rules for leaves: the week's reading and each pick's minutes (a pick that can't be assigned is left out
 * and its minutes go to reading), each pick's focus, what it is, where its rows come from and when one is done, then
 * the row shape and the rule that keeps a long task whole. A listed source's items still to do follow its pick's line,
 * one per line, and each is one row.
 */
function leafPracticeRules(input: UnitsPromptInput, aliases: MaterialAliases): string | null {
  const picks = pickSources(input.split, input.materials).filter((p) => p.assignable);
  if (picks.length === 0) return null;
  const days = input.level === "day";
  const budgets = weekBudgetsOf(input);
  const week = budgetFor(1, input.hoursPerWeek) * 60;
  const daysInWeek = days ? input.spans.length : input.daysPerWeek;
  const half = Math.round(leafBudgetMinutes("day", daysInWeek, input.hoursPerWeek) / 2 / 5) * 5;
  const lines = [`Practice: ${days ? "the" : "each"} week's time, about ${formatMinutes(week)}, is about ${formatMinutes(budgets.reading)} of reading and, by format:`];
  // A block is never split to fit a week's slice: it is budgeted over the plan, less what earlier units placed.
  const planBlocks = planBlockBudgets(input.split, budgetFor(input.weeks, input.hoursPerWeek) * 60, input.materials);
  const parent = input.tree && input.parentId ? findNode(input.tree, input.parentId) : null;
  let firstItem: string | null = null;
  for (const p of picks) {
    const spec = PRACTICE_REGISTRY[p.pick.format];
    let time = `about ${formatMinutes(budgets.practice[p.pick.format] ?? 0)} ${days ? "this week" : "a week"}`;
    let sizing = sizingSentence(p.pick.format);
    if (isBlockFormat(p.pick.format)) {
      const total = planBlocks[p.pick.format] ?? 0;
      const placed = input.tree && parent ? placedMinutes(input.tree, p.pick.format, parent.start - 1) : 0;
      const left = Math.max(0, total - placed);
      time = `about ${formatMinutes(total)} over the whole plan, ${placed > 0 ? `about ${formatMinutes(placed)} placed so far, so about ${formatMinutes(left)} left` : "none placed so far"}`;
      sizing = `${spec.label} comes in whole blocks of about ${spec.fixedMinutes} min: place one where a week has room, not a part of one each week.`;
    }
    const from = leafPickSources(input, aliases, p);
    if (from.items.length > 0) sizing = "Each listed item takes the minutes on its line.";
    lines.push(`- ${pickName(p.pick.format)}: ${time}, aimed at ${p.pick.focus}. The learner ${spec.prompt}. ${from.text} Done when: ${spec.doneWhen}.${sizing ? ` ${sizing}` : ""}`);
    lines.push(...from.items);
    firstItem ??= from.items[0]?.trim().split(" ")[0] ?? null;
  }
  const cutRule = cutSourceRule(picks, input.materials);
  if (cutRule) lines.push(cutRule);
  lines.push(
    `For each unit, list its practice rows in "practice" as { format, id, task, done, minutes }: format is one of the formats above; id is the row's source (leave it out for a row you write yourself); task says exactly what to do, with the part ("NeetCode 150 · Arrays & Hashing, problems 1–6"); done says how the learner knows it is finished; minutes is the doing time.`,
  );
  if (firstItem) {
    lines.push(`A listed item is one row: id is the item's own ("${firstItem}"), task may restate its title, minutes are its minutes; never an item not listed for the unit, and never one item twice.`);
  }
  // Block formats are held over the plan, so a week's minutes follow the blocks it holds.
  const blocks = picks.filter((p) => isBlockFormat(p.pick.format)).map((p) => `${PRACTICE_REGISTRY[p.pick.format].label}'s`);
  const except = blocks.length === 0 ? "" : `, except ${blocks.join(" and ")}: a week that holds a block takes its minutes from the other formats, and a week without one gives its time to them`;
  lines.push(`${days ? "Across the week" : "Within each week"}, each format's minutes add up to about its time${except}. Place a task longer than half a day's budget (about ${formatMinutes(half)}) on a day of its own.`);
  return lines.join("\n");
}

/**
 * The practice rules for headings: each pick's sources to reserve in order, with the part in the note, or, for a source
 * with an item list, only the units that take it: the app shares out its items over them (`sizeItemRuns`). Below the
 * top level only the parent's reserved sources are offered, or those no heading reserves. None when no pick has a source.
 */
function headingPracticeRules(input: UnitsPromptInput, aliases: MaterialAliases): string | null {
  const picks = pickSources(input.split, input.materials).filter((p) => p.assignable);
  if (!picks.some((p) => p.sources.length > 0)) return null;
  const kids = UNIT_NOUN[childLevel(input.level) ?? "day"];
  const cutRule = cutSourceRule(picks, input.materials);
  const anyListed = picks.some((p) => p.sources.some((id) => listOf(input, id)));
  const lines = [
    `Practice: for each unit, list in "practiceCovers" the practice sources its ${kids}s will use, as { format, id, note }: take each format's sources in order across the units, with the part this unit takes in note ("Arrays & Hashing; Two Pointers"). A source too long for one unit runs on in the next, a different part in each.${anyListed ? " A source with an item list is named alone, as { format, id }, with no note: the app gives each unit that names it its run of items." : ""}`,
    ...(cutRule ? [cutRule] : []),
  ];
  /** How a listed source is reserved: the model names the units that take it; the app sizes their runs (`sizeItemRuns`). */
  const runRule = (format: PracticeFormat, these: boolean) =>
    `list it on each unit that should practise it; the app shares out ${these ? "these" : "its"} items in order, each unit's run sized to its ${PRACTICE_REGISTRY[format].label} time.`;
  for (const p of picks) {
    const name = `- ${pickName(p.pick.format)}, aimed at ${p.pick.focus}`;
    const held = practiceHeld(input, aliases, p.pick.format);
    const reserved = reservedPractice(input, p.pick.format).filter((c) => c.id === null || aliases.alias(c.id) !== undefined);
    if (reserved.length > 0) {
      const unlisted = reserved.filter((c) => !listOf(input, c.id)).map((c) => practiceItem(c, aliases)).filter((s): s is string => s !== null);
      const listed = [...new Set(reserved.filter((c) => listOf(input, c.id)).map((c) => c.id!))].map((id) => {
        const positions = reservedPositions(reserved.filter((c) => c.id === id), listOf(input, id)!);
        return `${positionsText(aliases, id, positions)}: ${runRule(p.pick.format, true)}`;
      });
      const rest = unlisted.length === 0 ? "" : listed.length > 0 ? ` Also ${unlisted.join("; ")}.` : `${unlisted.join("; ")}.`;
      lines.push(`${name}: from this unit's reservation, ${listed.join(" ")}${rest}${held}`);
      continue;
    }
    const offered = offeredSources(input, p);
    if (offered.length > 0) {
      const listed = offered.filter((id) => listOf(input, id)).map((id) => `${aliases.alias(id)} has an item list: ${runRule(p.pick.format, false)}`);
      const unlisted = offered.filter((id) => !listOf(input, id)).map((id) => aliases.alias(id));
      const rest = unlisted.length === 0 ? "" : listed.length > 0 ? ` Also ${unlisted.join(", ")}.` : `${unlisted.join(", ")}.`;
      lines.push(`${name}: ${listed.join(" ")}${rest}${held}`);
    } else if (p.sources.length > 0) lines.push(`${name}: its sources are reserved by other units, so reserve nothing for it.`);
    else lines.push(`${name}: no source; its rows are written ${p.pick.format === "recall" ? "from the reading " : ""}later, so reserve nothing for it.`);
  }
  return lines.join("\n");
}

/** A leaf's budget: a day's share of a week of `daysInWeek` days, or a whole week. */
function leafBudgetMinutes(level: PlanLevel, daysInWeek: number, hoursPerWeek?: number): number {
  if (level === "day") return hoursPerWeek === undefined ? 60 : dayMinutes(hoursPerWeek, daysInWeek);
  return budgetFor(1, hoursPerWeek) * 60;
}

/** "Day 3", "Week 2 (5 study days)", "Month 1 (4 weeks)": one unit of the list the drafter is asked to fill. */
function unitLine(level: PlanLevel, index: number, len: number, daysPerWeek: number): string {
  const label = `${capitalize(level)} ${index + 1}`;
  if (level === "day") return label;
  if (level === "week") return `${label} (${len} study day${len === 1 ? "" : "s"})`;
  const weeks = Math.max(1, Math.round(len / daysPerWeek));
  return `${label} (${weeks} week${weeks === 1 ? "" : "s"})`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 90) return `${minutes} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

/**
 * What this unit's children may take, computed from the tree: the parent's reservation, and what every other unit
 * holds. At the top level everything is free.
 */
export function availabilityLines(input: UnitsPromptInput, aliases: MaterialAliases): string[] {
  const noun = UNIT_NOUN[input.level];
  const listedBackbone = input.materials.some((m) => m.backbone && m.toc);
  const parent = input.tree && input.parentId ? findNode(input.tree, input.parentId) : null;
  if (!input.tree || !parent) {
    const each = input.unitsAreLeaves
      ? `Read each in one ${noun}, or in consecutive ${noun}s when it is longer than one ${noun}'s reading time`
      : `Reserve each as the rules above say`;
    return [`Every resource is free. ${each}${listedBackbone ? "; the book's chapters in order" : ""}.`];
  }
  const lines: string[] = [];
  // A week split by hand passes its own Read table down as the reservation. Review rows from before reviews were
  // withdrawn reserve nothing for reading.
  const reserved = (parent.covers ?? parent.materials ?? []).filter((r) => aliases.alias(r.id));
  const toRead = reserved.filter((r) => activityOf(r) === "read");
  if (toRead.length > 0) lines.push(`This unit's reservation, the only resources its ${noun}s may use: ${describeRefs(toRead, aliases)}.`);
  else if (reserved.length > 0) lines.push(`This unit reserves nothing to read: its ${noun}s read nothing and the time is for ${practiceOf(input)}.`);
  else lines.push(`Take them from the list above, matching each unit's ground.`);
  const skip = new Set<string>([input.tree.id, parent.id]);
  for (let p = parentOf(input.tree, parent.id); p; p = parentOf(input.tree, p.id)) skip.add(p.id);
  const held: string[] = [];
  walk(input.tree, (n) => {
    if (skip.has(n.id)) return;
    const reads = [...(n.covers ?? []), ...(n.materials ?? [])].filter((r) => activityOf(r) === "read" && aliases.alias(r.id));
    if (reads.length > 0) held.push(`${describeRefs(reads, aliases)} (${fullLabelOf(input.tree!, n)})`);
  });
  if (held.length > 0) lines.push(`Held by other units: ${held.join("; ")}.`);
  return lines;
}

/** What the rest of a unit's time is for, in the plan's words. */
function practiceOf(input: UnitsPromptInput): string {
  return input.split ? practiceLabelOf(draftedSplit(input.split, input.materials)) : "building and practice";
}

function headingMaterialRules(input: UnitsPromptInput, aliases: MaterialAliases): string {
  const backbone = input.materials.findIndex((m) => m.backbone);
  const kids = UNIT_NOUN[childLevel(input.level) ?? "day"];
  const B = `M${backbone + 1}`;
  const lines = [
    `Materials: for each unit, list in "covers" the resources its ${kids}s will read, as { id, note }. note names the part, only for a resource without units ("lectures 3–4"); leave it out otherwise. No tier and no minutes yet: the units inside are planned later from this reservation.`,
  ];
  if (input.materials.some((m) => m.toc)) {
    lines.push(
      `A resource with units (Mn.1, Mn.2, …) is reserved by its units, never as a whole. Choose the units that serve its purpose and add up to about its budget, and reserve them in order across consecutive units at this level, each unit in exactly one.`,
    );
  }
  if (input.materials[backbone]?.toc) lines.push(`The backbone's units run in order through the plan.`);
  lines.push(
    `Any other resource is reserved in at most one unit at this level, unless its budget is more than one unit's reading time: then reserve it in consecutive units, naming the part in each note.`,
  );
  if (backbone < 0) lines.push(`Spread the materials where they fit best.`);
  else if (!input.materials[backbone].toc) {
    lines.push(
      `${B} is the backbone textbook, but its chapters are not listed: reserve it in order across the units and name each unit's part by topic ("the chapters on evaluation"). Never write a chapter number or a chapter title you were not given.`,
    );
  }
  lines.push(...availabilityLines(input, aliases));
  lines.push(`Use only ids from the list.`);
  return lines.join("\n");
}

function leafMaterialRules(input: UnitsPromptInput, aliases: MaterialAliases): string {
  const parent = input.tree && input.parentId ? findNode(input.tree, input.parentId) : null;
  // A week split into days by hand passes its own Read table down as the reservation.
  const reserved = (parent?.covers ?? parent?.materials ?? []).filter((r) => aliases.alias(r.id) && activityOf(r) === "read");
  const backbone = input.materials.findIndex((m) => m.backbone);
  const listed = backbone >= 0 && !!input.materials[backbone].toc;
  const B = `M${backbone + 1}`;
  const where = reserved.length > 0 ? "where the reservation has material for it" : "where the list has material for it";
  // Days are budgeted over their week, as the checks hold them: the week's must-reading, and each day's own total.
  const reading = formatMinutes(weekBudgetsOf(input).reading);
  const rules =
    input.level === "day"
      ? `Rules: the week has about ${reading} of reading; the rest of its time is for ${practiceOf(input)}. Across the week, the days' must minutes add up to no more than about ${reading}. A day may be all reading or all practice, but each day's must, should and practice minutes fit within its own budget. A day that reads has at least one must; should items are optional extras.`
      : `Rules: at least one must per unit${input.split ? ` ${where}` : ""}; must minutes stay within the must-reading on the unit's line, because the rest of the time is for ${practiceOf(input)}; should items are optional extras.`;
  const lines = [
    `Materials: for each unit, list its Read table in "materials" as { id, tier, minutes, note }. tier is "must" or "should"; minutes is the reading or watching time for this unit; note names the part: for a chapter, the sections this unit covers ("Post-Training; Sampling"), for anything else the part ("§2 only", "whole essay").`,
    ...availabilityLines(input, aliases),
    rules,
  ];
  const size = input.materials.some((m) => m.minutes) ? "Each resource's size is in the list. " : "";
  lines.push(
    `${size}A chapter longer than one unit's reading time spans consecutive units: list it in each with the part in the note; across those units its minutes add up to its size. A resource is read once: do not assign what another unit reads${listed ? `, and never refer to ${B} itself` : ""}.`,
  );
  lines.push(`A unit with nothing left to read in its reservation reads nothing: that time is for ${practiceOf(input)}. Never assign a resource a unit before it already read.`);
  if (backbone >= 0 && !listed) {
    lines.push(
      `${B} is the backbone textbook, but its chapters are not listed: it runs in order across the units, continuing from where earlier units stopped. Name each unit's part by topic ("the chapters on evaluation"). Never write a chapter number or a chapter title you were not given.`,
    );
  }
  lines.push(`Use only ids from the list.`);
  return lines.join("\n");
}

export interface RevisionPromptInput extends PlanPromptContext {
  tree: PlanNode;
  refs: Map<string, string>;
  lockBefore: number;
  changeRequest: string;
}

/** Asks the model for the whole revised tree, echoing refs for nodes it keeps. */
export function buildRevisionPrompt(input: RevisionPromptInput): string {
  const parts: string[] = [];
  // A listed source's alias, for the rule on runs and item rows.
  const listedAt = input.materials.findIndex((m) => m.practice?.list);
  const items = listedAt < 0 ? "" : ` A source with an item list is reserved by a run, { format, id, from, to }, and done one item per row, id the item's own (M${listedAt + 1}.1).`;
  parts.push(`You are revising a self-study plan. The plan is a tree: months contain weeks, weeks contain days. A unit with no children is a heading that gets planned in detail later, or the finest unit the learner works at.`);
  parts.push(...contextLines(input, { sections: true }));
  const hasMaterials = input.materials.length > 0;
  parts.push(`Current plan (${planLength(input.tree, input.daysPerWeek)}). Every unit has a ref in square brackets${hasMaterials ? "; braces show the materials a heading reserves (covers) or a unit reads (materials)" : ""}:`);
  parts.push(renderTree(input.tree, { daysPerWeek: input.daysPerWeek, refs: input.refs, lockBefore: input.lockBefore, aliases: hasMaterials ? aliasMaterials(input.materials) : undefined }));
  parts.push(`The learner asks: "${input.changeRequest}"`);
  parts.push(
    [
      `Return the complete revised plan as nested units.`,
      `Rules:`,
      `- Keep the ref of every unit you keep, even if you move it or edit its title. Leave the ref out for brand-new units.`,
      `- Units marked done or locked must come back unchanged, with the same ref, in the same place. Never drop or edit them.`,
      `- "days" is a unit's span in study days. A day unit has days = 1. A week has as many days as the learner studies that week: ${input.daysPerWeek} for a new week, and a week already split keeps its number of days. A month's days is the sum of its weeks' days. The days of a unit's children must add up to that unit's days.`,
      `- Change only what the request asks for. Do not plan headings in detail unless asked; do not fold planned units back into headings unless asked.`,
      `- Keep the same depth: a unit's children stay at the level below it (month → week → day).`,
      `- Keep the total length unless the request changes it.`,
      ...(hasMaterials
        ? [
            `- Materials: return "covers" (headings: { id, note }) and "materials" (units without children: { id, tier, minutes, note }) for every unit that has them, changed only as the request asks. Ids may name a resource (M3) or a chapter (M1.3); a resource is read in one unit. A request like "make the talk optional" changes that row's tier to "should"; it does not add or drop other rows. Leave both fields out only for units with no materials. Use only ids from the list.`,
            `- Practice: return "practiceCovers" (headings: { format, id, note }) and "practice" (units without children: { format, id, task, done, minutes }) for every unit that has them, changed only as the request asks. Keep each row's format and source id; leave id out only for a row you wrote.${items}`,
          ]
        : []),
    ].join("\n"),
  );
  return parts.join("\n");
}

/** "6 weeks, usually 5 study days a week": the plan's length as prompts state it. */
function planLength(tree: PlanNode, daysPerWeek: number): string {
  return `${weeksLabel(weeksOf(tree, tree, daysPerWeek))}, usually ${daysPerWeek} study day${daysPerWeek === 1 ? "" : "s"} a week`;
}

export interface ChatPromptInput extends PlanPromptContext {
  mode: "create" | "adjust";
  tree: PlanNode;
  lockBefore: number;
}

export function buildPlanChatSystemPrompt(input: ChatPromptInput): string {
  const parts: string[] = [];
  parts.push(
    `You are Pensieve, a study planner helping a learner shape a self-study plan on "${input.topic}". The plan is shown beside this conversation as a tree: months contain weeks, weeks contain days. A unit with no children is either a heading that gets planned in detail when the learner reaches it, or (on week-sized plans) a week the learner works through in sessions of their own choosing.`,
  );
  if (input.instructions?.trim()) parts.push(`The learner's focus & instructions: "${input.instructions.trim()}"`);
  parts.push(...timeLines(input));
  const hasMaterials = input.materials.length > 0;
  if (hasMaterials) {
    parts.push(`The plan's materials (the learner's own, plus what research found and checked):`);
    parts.push(renderMaterials(input.materials));
  }
  parts.push(`Plan length: ${planLength(input.tree, input.daysPerWeek)}, planned in ${input.granularity} units. Each week's days are numbered from Day 1.`);
  if (input.mode === "adjust") {
    parts.push(
      input.lockBefore > 0
        ? `This is an existing track. Units marked done or locked are completed; only later units can change. Never propose changes to locked units.`
        : `This is an existing track with nothing completed yet; everything can change.`,
    );
  }
  parts.push(`Current plan:`);
  parts.push(renderTree(input.tree, { daysPerWeek: input.daysPerWeek, lockBefore: input.lockBefore, aliases: hasMaterials ? aliasMaterials(input.materials) : undefined }));
  parts.push(
    [
      `There are two kinds of turns.`,
      `1. Questions about the plan ("why is X first", "why does this matter", "how long per day"): answer in 2–5 sentences of plain prose, grounded in the specific units above. Do not call any tool. If the learner might wonder, end by noting that the plan is unchanged.`,
      `2. Requests to change the plan (add, remove, drop, move, swap, split, merge, rework, shorten, extend, reorder, expand or plan a unit in detail, collapse a unit back to a heading, focus more on something): call revisePlan exactly once. Write the changeRequest as a precise instruction that captures the whole conversation's intent, including anything agreed in earlier turns, and name the units by their labels ("Week 3", "Month 2 · Week 1", "Week 2 · Day 4"). After the tool returns, write a 1–2 sentence change note in plain prose that starts by naming the level the change happened at ("Changed at the week level: …" / "Changed days inside Week 2: …"), says what moved, split or was dropped, and says whether the units inside are untouched. Never describe a change you did not make with the tool.`,
      ...(hasMaterials
        ? [
            `Changing which materials a unit reads, or a row's tier, minutes or note, is a change: call revisePlan. Adding a material that is not in the list is not possible here yet; say so and suggest the closest material in the list.`,
          ]
        : []),
      `If a message could be either, treat it as a question and offer to make the change.`,
      `No markdown headings or bullet lists. Short plain paragraphs.`,
    ].join("\n"),
  );
  return parts.join("\n");
}
