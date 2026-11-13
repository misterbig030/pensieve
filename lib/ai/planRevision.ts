import {
  budgetFor,
  childLevel,
  cloneTree,
  findNode,
  fullLabelOf,
  isLocked,
  layout,
  makeNode,
  makeRoot,
  MAX_DAYS_PER_WEEK,
  topLevelFor,
  walk,
  weeksOf,
  type Granularity,
  type PlanLevel,
  type PlanNode,
} from "@/lib/planTree";
import {
  aliasMaterials,
  keepCoverTiers,
  keepPracticeCovers,
  pickedFormats,
  plainUnitText,
  practiceRowKey,
  refKey,
  resolveCoverRefs,
  resolveMaterialRefs,
  resolvePracticeCovers,
  importedRowsOf,
  markImported,
  resolvePracticeRefs,
  treeChecks,
  type MaterialAliases,
} from "@/lib/materials";
import type { PracticeFormat } from "@/lib/practice";
import type { PracticeCover, PracticeRef } from "@/lib/schemas/material";
import type { PlanSplit } from "@/lib/studyTime";
import { capProblems, revisedTreeSchema, type RevisedNode, type RevisedTree } from "@/lib/schemas/plan";
import { loggedGenerateObject, type GenerationLogContext } from "./logged";
import { DEFAULT_OUTLINE_MODEL, OUTLINE_EFFORT } from "./models";
import { appModel, type ResolvedModel } from "./resolve";
import { assignRefs, buildRevisionPrompt, type PlanPromptContext } from "./planPrompt";
import { clampedTimeFacts, setProblems, toUnitTime } from "./planDraft";

/** Resolved with itemless rows kept, so `keptItemless` can tell the unit's saved ones from new ones. */
const SAVED = { keepUnitemized: true } as const;

/**
 * A row of a listed source without an item, or a reservation of one without a run, stays only when the unit already
 * had it (a plan saved before item lists): same format, source and task. One the model added or changed is unknown and
 * goes, as it would while drafting.
 */
function keptItemless<T extends PracticeRef | PracticeCover>(next: T[], before: T[] | undefined, aliases: MaterialAliases): T[] {
  const itemless = (r: PracticeRef | PracticeCover) => r.id !== null && aliases.items(r.id) > 0 && !r.itemFrom && !("generated" in r && r.generated);
  return next.filter((r) => !itemless(r) || (before ?? []).some((o) => itemless(o) && o.format === r.format && o.id === r.id && (o.task ?? null) === (r.task ?? null)));
}

export class LockedNodeError extends Error {
  constructor(label: string) {
    super(`The change would touch ${label}, which is already completed. Pick something later in the plan.`);
    this.name = "LockedNodeError";
  }
}

/**
 * Turns the model's revised tree back into `PlanNode`s. Kept nodes (by ref) keep their id and status; locked nodes
 * are restored verbatim from the original tree; new nodes get temporary ids. Throws when a locked node went missing.
 * With `aliases`, material references come back too: a field the model left out keeps the node's old references,
 * headings keep `covers`, leaves keep `materials`, and ids not in the list are dropped. Practice follows the same
 * rules: leaves keep `practice` (a rewritten list goes through `resolvePracticeRefs`, which drops refused and unknown
 * rows), headings keep `practiceCovers`, and a split week's reservations keep their `task` and `minutes`, its generated
 * ones whatever the model wrote. A heading takes the `time` the model wrote (for the formats in `picked`, as drafting
 * does; the formats left out go into `unpicked`), else keeps its own; a new heading the model gave none has none, which
 * the checks report. Leaves have none.
 */
export function applyRevision(
  original: PlanNode,
  refs: Map<string, string>,
  revised: RevisedTree,
  lockBefore: number,
  granularity: Granularity,
  aliases?: MaterialAliases,
  hoursPerWeek?: number,
  daysPerWeek: number = MAX_DAYS_PER_WEEK,
  split?: PlanSplit | null,
  picked: readonly PracticeFormat[] = pickedFormats(split),
  unpicked?: Set<PracticeFormat>,
): PlanNode {
  const byRef = new Map<string, PlanNode>();
  for (const [id, ref] of refs) {
    const node = findNode(original, id);
    if (node) byRef.set(ref, node);
  }
  const topLevel: PlanLevel = original.children?.[0]?.level ?? topLevelFor(weeksOf(original, original, daysPerWeek));
  const seen = new Set<string>();
  // The learner's rows anywhere in the plan: a row the model moves to another unit, or rewrites, is still theirs.
  const imported = importedRowsOf(original);

  const convert = (unit: RevisedNode, level: PlanLevel): PlanNode => {
    const kept = unit.ref ? byRef.get(unit.ref) : undefined;
    if (kept) seen.add(kept.id);
    if (kept && isLocked(kept, lockBefore)) return cloneTree(kept);
    const below = childLevel(level);
    const children = unit.children && below ? unit.children.map((c) => convert(c, below)) : null;
    const len = spanFor(level, unit.days, kept, daysPerWeek);
    // A week-plan's finest unit is a week; a month not yet planned in weeks is still a heading, as drafting has it.
    const leafWeek = children === null && level === "week" && granularity === "week";
    const leaf = children === null && (level === "day" || leafWeek);
    const covers = aliases && unit.covers !== undefined ? keepCoverTiers(resolveCoverRefs(unit.covers, aliases).refs, kept?.covers) : kept?.covers;
    const materials = aliases && unit.materials !== undefined ? resolveMaterialRefs(unit.materials, aliases).refs : kept?.materials;
    const practiceCovers =
      aliases && unit.practiceCovers !== undefined
        ? keptItemless(keepPracticeCovers(resolvePracticeCovers(unit.practiceCovers, aliases, split, SAVED).refs, kept?.practiceCovers, aliases.practice), kept?.practiceCovers, aliases)
        : kept?.practiceCovers;
    const practice =
      aliases && unit.practice !== undefined
        ? keptItemless(resolvePracticeRefs(markImported(unit.practice, imported, aliases), aliases, split, (materials ?? []).map((r) => r.id), SAVED).refs, kept?.practice, aliases)
        : kept?.practice;
    let time = leaf ? undefined : kept?.time;
    if (unit.time && !leaf) {
      const written = toUnitTime(unit.time, picked);
      time = written.time;
      for (const f of written.unpicked) unpicked?.add(f);
    }
    return makeNode({
      id: kept?.id,
      level,
      title: unit.title,
      summary: unit.summary,
      len,
      status: kept?.status ?? "pending",
      budgetHours: leafWeek ? (kept?.budgetHours ?? budgetFor(1, hoursPerWeek)) : null,
      manualSplit: kept?.manualSplit ?? false,
      children,
      covers: leaf ? undefined : covers,
      materials: leaf ? materials : undefined,
      practiceCovers: leaf ? undefined : practiceCovers,
      practice: leaf ? practice : undefined,
      time,
    });
  };

  const tops = revised.units.map((u) => convert(u, topLevel));
  const root = makeRoot(tops);

  walk(original, (node) => {
    if (node.id === original.id) return;
    if (isLocked(node, lockBefore) && !findNode(root, node.id)) throw new LockedNodeError(describe(original, node));
  });
  return layout(root);
}

/**
 * A unit's length in study days, whatever the model wrote for it: a day is one; a week the model kept keeps its days
 * and a new one has the usual number; a month keeps its days unless the model changed them, and is otherwise whole
 * weeks. A planned unit's length is its children's, set by `layout`.
 */
export function spanFor(level: PlanLevel, days: number, kept: PlanNode | undefined, daysPerWeek: number): number {
  if (level === "day") return 1;
  const same = kept && kept.level === level;
  if (level === "week") return same ? kept.len : daysPerWeek;
  // A month can be made longer or shorter ("the last month should be 2 weeks"); one left as it was keeps its days.
  if (same && Math.round(days) === kept.len) return kept.len;
  return Math.max(1, Math.round(days / daysPerWeek)) * daysPerWeek;
}

/** How a locked unit is named to the learner: a day by its label, anything larger by its title. */
export function describe(root: PlanNode, node: PlanNode): string {
  return node.level === "day" ? fullLabelOf(root, node) : `"${node.title}"`;
}

export interface RevisePlanInput extends PlanPromptContext {
  tree: PlanNode;
  lockBefore: number;
  changeRequest: string;
  /** The model that redrafts the tree; the app's outline model when omitted. */
  outlineModel?: ResolvedModel;
  log?: GenerationLogContext;
}

export interface RevisePlanResult {
  tree: PlanNode;
  costUsd: number;
  /** What the checks found in the revised tree, in the learner's words; the tree is kept as the model wrote it. */
  problems: string[];
}

/**
 * The units a revision added or reshaped: not in the saved tree, or with another level, span or reservations
 * (materials and practice sources) than the saved unit. These are held to drafting's rule that a heading states its
 * time (`no-time`); a kept unit that came back as it was, such as a heading of a plan saved before unit time, is not.
 */
export function reshapedUnits(original: PlanNode, revised: PlanNode): (node: PlanNode) => boolean {
  const shape = (n: PlanNode) => JSON.stringify([n.level, n.len, (n.covers ?? []).map(refKey), (n.practiceCovers ?? []).map((c) => practiceRowKey("", c))]);
  const saved = new Map<string, string>();
  walk(original, (n) => void saved.set(n.id, shape(n)));
  const changed = new Set<string>();
  walk(revised, (n) => {
    if (saved.get(n.id) !== shape(n)) changed.add(n.id);
  });
  return (node) => changed.has(node.id);
}

/**
 * What the learner is told about units the revision put one level up because their depth skipped a level: they came
 * back without the unit they belong in, so they may sit at the wrong level.
 */
export function movedProblems(titles: string[]): string[] {
  if (titles.length === 0) return [];
  const names = titles.map((t) => `"${t}"`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const they = titles.length === 1 ? "it was" : "they were";
  return [`${list} came back without the unit ${titles.length === 1 ? "it belongs" : "they belong"} in, so ${they} placed one level up. Check where ${titles.length === 1 ? "it sits" : "they sit"}.`];
}

/**
 * Runs one revision: the model returns the whole tree with refs, and `applyRevision` reconciles it. The checks run
 * tree-wide inside the call's `check` hook, so their facts land on the call's log row; what breaks a rule is kept as
 * written and comes back as `problems`. A revision is one large call, so there is no retry.
 */
export async function revisePlanTree(input: RevisePlanInput): Promise<RevisePlanResult> {
  const tree = layout(cloneTree(input.tree));
  const refs = assignRefs(tree);
  const model = input.outlineModel ?? appModel(DEFAULT_OUTLINE_MODEL);
  const aliases = input.materials.length > 0 ? aliasMaterials(input.materials) : undefined;
  // The formats a heading's time may name, as drafting has them: the split's picks the plan's sources can be given.
  const picked = pickedFormats(input.split, input.materials);
  let revised: PlanNode | null = null;
  let problems: string[] = [];
  let failure: unknown;
  const check = (object: RevisedTree): string[] => {
    const unpicked = new Set<PracticeFormat>();
    try {
      revised = applyRevision(tree, refs, object, input.lockBefore, input.granularity, aliases, input.hoursPerWeek, input.daysPerWeek, input.split, picked, unpicked);
    } catch (error) {
      failure = error;
      return [];
    }
    const dropped = unpicked.size > 0 ? [`dropped time for unpicked ${[...unpicked].join(", ")}`] : [];
    // Units whose depth skipped a level were put one level up: the learner checks where they landed.
    const moved = movedProblems(object.moved ?? []);
    dropped.push(...(object.moved ?? []).map((title) => `moved up a level: "${title}"`));
    // Every unit the model gave minutes past what a saved unit keeps (`toUnitTime` clamps a heading's; a leaf's goes).
    const times: RevisedNode["time"][] = [];
    const collect = (u: RevisedNode) => {
      times.push(u.time);
      for (const c of u.children ?? []) collect(c);
    };
    for (const u of object.units) collect(u);
    dropped.push(...clampedTimeFacts(times));
    if (!aliases) {
      problems = capProblems(moved);
      return dropped;
    }
    // Practice rows unchanged from the saved tree keep the item and reserved-source rules as facts; new or changed ones
    // breach. Only the units the revision added or reshaped are reported for lacking time.
    const checks = treeChecks(revised, input.materials, {
      granularity: input.granularity,
      hoursPerWeek: input.hoursPerWeek,
      daysPerWeek: input.daysPerWeek,
      split: input.split,
      original: tree,
      drafted: reshapedUnits(tree, revised),
    });
    // A breach of a locked or completed unit is the learner's to see nowhere: the unit can't change. It stays a fact for
    // the admin panel, as a re-draft's kept units' do. A plan-wide breach counts every unit and stays a problem.
    const fixed = (i: number) => {
      const owner = checks.owners[i];
      return owner !== null && (owner.status === "completed" || isLocked(owner, input.lockBefore));
    };
    problems = capProblems([...moved, ...checks.problems.filter((_, i) => !fixed(i))]);
    let plain = 0;
    walk(revised, (node) => void (plain += plainUnitText(node, input.materials, aliases)));
    const words = plain > 0 ? [`ids put in words in ${plain} field${plain === 1 ? "" : "s"}`] : [];
    return [...checks.facts, ...checks.breaches.map((b, i) => `${fixed(i) ? "locked unit" : "breach"}: ${b.text}`), ...dropped, ...words];
  };
  const { costUsd } = await loggedGenerateObject(
    {
      model: model.id,
      languageModel: typeof model.model === "string" ? undefined : model.model,
      keyOwner: model.keyOwner,
      schema: revisedTreeSchema,
      prompt: buildRevisionPrompt({ ...input, tree, refs }),
      effort: OUTLINE_EFFORT,
      label: `Revision · ${input.changeRequest.length > 60 ? `${input.changeRequest.slice(0, 57)}…` : input.changeRequest}`,
      check,
    },
    { ...input.log, caller: "outline_revision" },
  );
  if (failure !== undefined) throw failure;
  if (!revised) throw new Error("Revision ended without a tree");
  // The revision's problems stay with the tree, as a draft's do, so confirming the plan saves them.
  setProblems(revised, problems);
  return { tree: revised, costUsd, problems };
}
