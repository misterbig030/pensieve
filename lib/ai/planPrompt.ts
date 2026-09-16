import {
  childLevel,
  labelOf,
  spanOf,
  walk,
  type Granularity,
  type PlanLevel,
  type PlanNode,
} from "@/lib/planTree";
import type { SourceInput } from "@/lib/schemas/source";

export interface PlanPromptContext {
  topic: string;
  instructions?: string;
  sources: { url: string; title?: string }[] | SourceInput[];
  granularity: Granularity;
}

export interface RenderTreeOptions {
  /** Node id → short ref shown as `[n3]`, for prompts whose answer must echo refs. */
  refs?: Map<string, string>;
  /** Days on or before this are completed and locked. */
  lockBefore?: number;
  /** Prefix this node's line with `>>` so the model knows which one is meant. */
  markId?: string;
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
    lines.push(`${indent}${prefix}${label}${ref ? ` [${ref}]` : ""}${span}: "${node.title}" — ${node.summary}${mark}`);
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

function contextLines(ctx: PlanPromptContext): string[] {
  const parts: string[] = [];
  parts.push(`Topic: ${ctx.topic}`);
  if (ctx.instructions?.trim()) parts.push(`The learner's focus & instructions: "${ctx.instructions.trim()}"`);
  if (ctx.sources.length > 0) {
    parts.push(`The learner provided these reference materials — let them shape order and coverage where relevant:`);
    for (const s of ctx.sources) parts.push(`- ${s.title ?? s.url} (${s.url})`);
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
  parts.push(`You are designing a self-study curriculum, one unit at a time.`);
  parts.push(...contextLines(input));
  parts.push(`The whole plan is ${input.totalDays} days long.`);

  if (input.tree && input.parentId) {
    parts.push(`Here is the plan so far. Lines marked done are behind the learner; use what they covered to plan what comes next.`);
    parts.push(renderTree(input.tree, { markId: input.parentId }));
    parts.push(`Plan the ${noun}s inside the unit marked ">>" in detail. Its ${n} ${noun}s cover, in order:`);
  } else {
    parts.push(`Split the plan into ${n} ${noun}${n === 1 ? "" : "s"}, easiest and most foundational first, hardest and most applied last. They cover, in order:`);
  }

  let day = input.startDay;
  input.spans.forEach((len, i) => {
    const end = day + len - 1;
    parts.push(`${i + 1}. ${len === 1 ? `Day ${day}` : `Days ${day}–${end} (${len} days)`}`);
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
  parts.push(
    `Decide for yourself whether this topic needs current, real-time information — if so, search the web before answering. Otherwise rely on your own knowledge.`,
  );
  return parts.join("\n");
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
  parts.push(`Current plan (${input.tree.len} days). Every unit has a ref in square brackets:`);
  parts.push(renderTree(input.tree, { refs: input.refs, lockBefore: input.lockBefore }));
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
  if (input.sources.length > 0) {
    parts.push(`Materials the learner provided: ${input.sources.map((s) => s.title ?? s.url).join("; ")}.`);
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
  parts.push(renderTree(input.tree, { lockBefore: input.lockBefore }));
  parts.push(
    [
      `There are two kinds of turns.`,
      `1. Questions about the plan ("why is X first", "why does this matter", "how long per day"): answer in 2–5 sentences of plain prose, grounded in the specific units above. Do not call any tool. If the learner might wonder, end by noting that the plan is unchanged.`,
      `2. Requests to change the plan (add, remove, drop, move, swap, split, merge, rework, shorten, extend, reorder, expand or plan a unit in detail, collapse a unit back to a heading, focus more on something): call revisePlan exactly once. Write the changeRequest as a precise instruction that captures the whole conversation's intent, including anything agreed in earlier turns, and name the units by their labels ("Week 3", "Month 2 · Week 1", "Day 9"). After the tool returns, write a 1–2 sentence change note in plain prose that starts by naming the level the change happened at ("Changed at the week level: …" / "Changed days inside Week 2: …"), says what moved, split or was dropped, and says whether the units inside are untouched. Never describe a change you did not make with the tool.`,
      `If a message could be either, treat it as a question and offer to make the change.`,
      `No markdown headings or bullet lists. Short plain paragraphs.`,
    ].join("\n"),
  );
  return parts.join("\n");
}
