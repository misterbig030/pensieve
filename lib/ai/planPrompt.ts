import { MUST_SHARE, aliasMaterials, type MaterialAliases } from "@/lib/materials";
import {
  budgetFor,
  childLevel,
  findNode,
  labelOf,
  spanOf,
  walk,
  type Granularity,
  type PlanLevel,
  type PlanNode,
} from "@/lib/planTree";
import type { CoverRef, Material, MaterialRef } from "@/lib/schemas/material";

export interface PlanPromptContext {
  topic: string;
  instructions?: string;
  /** The plan's materials list: the learner's sources and what research verified. */
  materials: Material[];
  granularity: Granularity;
}

export interface RenderTreeOptions {
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

/** "covers M1 (ch. 1–2), M4" for a heading; "reads M1 must 90 min (ch. 1); M3 should 20 min" for a leaf. */
export function renderRefs(node: Pick<PlanNode, "covers" | "materials">, aliases: MaterialAliases): string {
  const parts: string[] = [];
  const covers = (node.covers ?? []).filter((r) => aliases.alias(r.id));
  const reads = (node.materials ?? []).filter((r) => aliases.alias(r.id));
  if (covers.length > 0) parts.push(`covers ${covers.map((r: CoverRef) => `${aliases.alias(r.id)}${refNote(r.note)}`).join(", ")}`);
  if (reads.length > 0) {
    parts.push(
      `reads ${reads.map((r: MaterialRef) => `${aliases.alias(r.id)} ${r.tier}${r.minutes !== null ? ` ${r.minutes} min` : ""}${refNote(r.note)}`).join("; ")}`,
    );
  }
  return parts.join(" · ");
}

/** Renders the tree as indented text the model can read: labels, spans, titles, summaries, done/locked marks. */
export function renderTree(root: PlanNode, opts: RenderTreeOptions = {}): string {
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
    const span = node.len === 1 ? "" : ` (${spanOf(node)}, ${node.len} days)`;
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

/** One line per material: `M1 [book · backbone] "AI Engineering" — Chip Huyen, 2024. Why: …`. */
export function renderMaterials(materials: Material[], aliases: MaterialAliases = aliasMaterials(materials)): string {
  return materials
    .map((m) => {
      const tags = [m.kind, m.backbone ? "backbone" : null, m.origin === "learner" ? "the learner's own" : null].filter(Boolean).join(" · ");
      const byline = [m.author, m.year].filter(Boolean).join(", ");
      const where = m.type === "note" || m.type === "file" ? "" : ` <${m.url}>`;
      return `${aliases.alias(m.id)} [${tags}] "${m.title}"${byline ? ` — ${byline}` : ""}${where}${m.why ? `. ${m.why}` : ""}`;
    })
    .join("\n");
}

function contextLines(ctx: PlanPromptContext): string[] {
  const parts: string[] = [];
  parts.push(`Topic: ${ctx.topic}`);
  if (ctx.instructions?.trim()) parts.push(`The learner's focus & instructions: "${ctx.instructions.trim()}"`);
  if (ctx.materials.length > 0) {
    parts.push(`The plan's materials. The learner's own are always part of it; the rest were found and checked by research. Refer to them by id:`);
    parts.push(renderMaterials(ctx.materials));
  }
  return parts;
}

const UNIT_NOUN: Record<PlanLevel, string> = { month: "month", week: "week", day: "day" };

export interface UnitsPromptInput extends PlanPromptContext {
  /** The level of the units being written. */
  level: PlanLevel;
  /** Span of each unit in days, in order. */
  spans: number[];
  /** Day index of the first unit's first day. */
  startDay: number;
  /** Whole plan length in days. */
  totalDays: number;
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
  parts.push(...contextLines(input));
  parts.push(`The whole plan is ${input.totalDays} days long.`);

  if (input.tree && input.parentId) {
    parts.push(`Here is the plan so far. Lines marked done are behind the learner; use what they covered to plan what comes next.${hasMaterials ? " Braces show the materials each unit reserves or reads." : ""}`);
    parts.push(renderTree(input.tree, { markId: input.parentId, aliases: hasMaterials ? aliases : undefined }));
    parts.push(`Plan the ${noun}s inside the unit marked ">>" in detail. Its ${n} ${noun}s cover, in order:`);
  } else {
    parts.push(`Split the plan into ${n} ${noun}${n === 1 ? "" : "s"}, easiest and most foundational first, hardest and most applied last. They cover, in order:`);
  }

  let day = input.startDay;
  input.spans.forEach((len, i) => {
    const end = day + len - 1;
    const minutes = input.unitsAreLeaves ? leafBudgetMinutes(input.level, len) : null;
    const budget = hasMaterials && minutes !== null ? ` — budget about ${formatMinutes(minutes)}, so about ${formatMinutes(Math.round((minutes * MUST_SHARE) / 5) * 5)} of must-reading` : "";
    parts.push(`${i + 1}. ${len === 1 ? `Day ${day}` : `Days ${day}–${end} (${len} days)`}${budget}`);
    day = end + 1;
  });

  if (input.unitsAreLeaves) {
    parts.push(
      input.level === "day"
        ? `Each day is one focused lesson of roughly 45–60 minutes.`
        : `Each ${noun} is a goal the learner works toward across several sessions of their own choosing; describe the whole ${noun}'s ground, not a day-by-day list.`,
    );
  } else {
    parts.push(`Each ${noun} is a heading that will be planned in detail later, when the learner reaches it. Make the headings distinct and progressive.`);
  }
  parts.push(
    `Return exactly ${n} units in that order. Title: a short noun phrase (at most 8 words) with no "Week 1:" or "Day 3:" prefix. Summary: one sentence on what it covers and why it comes here.`,
  );
  if (hasMaterials) parts.push(input.unitsAreLeaves ? leafMaterialRules(input, aliases) : headingMaterialRules(input));
  return parts.join("\n");
}

function leafBudgetMinutes(level: PlanLevel, len: number): number {
  return level === "day" ? 60 : budgetFor(len) * 60;
}

function formatMinutes(minutes: number): string {
  if (minutes < 90) return `${minutes} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

function headingMaterialRules(input: UnitsPromptInput): string {
  const backbone = input.materials.findIndex((m) => m.backbone);
  return [
    `Materials: for each unit, list in "covers" the materials its ${UNIT_NOUN[input.level]} will read, as { id, note } with a note naming the part ("ch. 5–6", "whole essay", "lectures 3–4"). No tier and no minutes yet: the units inside are planned later from this reservation.`,
    backbone >= 0
      ? `M${backbone + 1} is the backbone textbook: reserve its chapters in order across the units, each chapter in exactly one unit, and name them in the note.`
      : `There is no backbone textbook; spread the materials where they fit best.`,
    `Use only ids from the list.`,
  ].join("\n");
}

function leafMaterialRules(input: UnitsPromptInput, aliases: MaterialAliases): string {
  const parent = input.tree && input.parentId ? findNode(input.tree, input.parentId) : null;
  // A week split into days by hand passes its own Read table down as the reservation.
  const reserved = (parent?.covers ?? parent?.materials ?? []).filter((r) => aliases.alias(r.id));
  const backbone = input.materials.findIndex((m) => m.backbone);
  const lines = [
    `Materials: for each unit, list its Read table in "materials" as { id, tier, minutes, note }. tier is "must" or "should"; minutes is the reading or watching time for this unit; note names the part ("Ch. 4 §2", "evals and guardrails sections only").`,
    reserved.length > 0
      ? `Take them first from what the unit marked ">>" reserved: ${reserved.map((r) => `${aliases.alias(r.id)}${refNote(r.note)}`).join(", ")}. Use the rest of the list only to fill a gap.`
      : `Take them from the list above, matching each unit's ground.`,
    `Rules: at least one must per unit; must minutes stay within about ${Math.round(MUST_SHARE * 100)}% of the unit's budget, because the rest of the time is for building and practice; should items are optional extras.`,
  ];
  if (backbone >= 0) lines.push(`M${backbone + 1} is the backbone textbook: its chapters run in order across the units, continuing from where earlier units stopped. Name the chapter in the note.`);
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
  parts.push(`You are revising a self-study plan. The plan is a tree: months contain weeks, weeks contain days. A unit with no children is a heading that gets planned in detail later, or the finest unit the learner works at.`);
  parts.push(...contextLines(input));
  const hasMaterials = input.materials.length > 0;
  parts.push(`Current plan (${input.tree.len} days). Every unit has a ref in square brackets${hasMaterials ? "; braces show the materials a heading reserves (covers) or a unit reads (materials)" : ""}:`);
  parts.push(renderTree(input.tree, { refs: input.refs, lockBefore: input.lockBefore, aliases: hasMaterials ? aliasMaterials(input.materials) : undefined }));
  parts.push(`The learner asks: "${input.changeRequest}"`);
  parts.push(
    [
      `Return the complete revised plan as nested units.`,
      `Rules:`,
      `- Keep the ref of every unit you keep, even if you move it or edit its title. Leave the ref out for brand-new units.`,
      `- Units marked done or locked must come back unchanged, with the same ref, in the same place. Never drop or edit them.`,
      `- "days" is a unit's span. A day unit has days = 1. A week or month heading's days is its whole span. The days of a unit's children must add up to that unit's days.`,
      `- Change only what the request asks for. Do not plan headings in detail unless asked; do not fold planned units back into headings unless asked.`,
      `- Keep the same depth: a unit's children stay at the level below it (month → week → day).`,
      `- Keep the total length unless the request changes it.`,
      ...(hasMaterials
        ? [
            `- Materials: return "covers" (headings: { id, note }) and "materials" (units without children: { id, tier, minutes, note }) for every unit that has them, changed only as the request asks. A request like "make the talk optional" changes that row's tier to "should"; it does not add or drop other rows. Leave both fields out only for units with no materials. Use only ids from the list.`,
          ]
        : []),
    ].join("\n"),
  );
  return parts.join("\n");
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
  const hasMaterials = input.materials.length > 0;
  if (hasMaterials) {
    parts.push(`The plan's materials (the learner's own, plus what research found and checked):`);
    parts.push(renderMaterials(input.materials));
  }
  parts.push(`Plan length: ${input.tree.len} days, planned in ${input.granularity} units.`);
  if (input.mode === "adjust") {
    parts.push(
      input.lockBefore > 0
        ? `This is an existing track. ${input.lockBefore === 1 ? "Day 1 is" : `Days 1–${input.lockBefore} are`} completed and locked; only later units can change. Never propose changes to locked units.`
        : `This is an existing track with nothing completed yet; everything can change.`,
    );
  }
  parts.push(`Current plan:`);
  parts.push(renderTree(input.tree, { lockBefore: input.lockBefore, aliases: hasMaterials ? aliasMaterials(input.materials) : undefined }));
  parts.push(
    [
      `There are two kinds of turns.`,
      `1. Questions about the plan ("why is X first", "why does this matter", "how long per day"): answer in 2–5 sentences of plain prose, grounded in the specific units above. Do not call any tool. If the learner might wonder, end by noting that the plan is unchanged.`,
      `2. Requests to change the plan (add, remove, drop, move, swap, split, merge, rework, shorten, extend, reorder, expand or plan a unit in detail, collapse a unit back to a heading, focus more on something): call revisePlan exactly once. Write the changeRequest as a precise instruction that captures the whole conversation's intent, including anything agreed in earlier turns, and name the units by their labels ("Week 3", "Month 2 · Week 1", "Day 9"). After the tool returns, write a 1–2 sentence change note in plain prose that starts by naming the level the change happened at ("Changed at the week level: …" / "Changed days inside Week 2: …"), says what moved, split or was dropped, and says whether the units inside are untouched. Never describe a change you did not make with the tool.`,
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
