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
import { aliasMaterials, dropBreaches, keepCoverTiers, keepPracticeCovers, resolveCoverRefs, resolveMaterialRefs, resolvePracticeCovers, resolvePracticeRefs, treeChecks, type MaterialAliases } from "@/lib/materials";
import type { CoverRefDraft, MaterialRefDraft, PracticeCover, PracticeCoverDraft, PracticeRef, PracticeRefDraft } from "@/lib/schemas/material";
import type { PlanSplit } from "@/lib/studyTime";
import { revisedTreeSchema, type RevisedTree } from "@/lib/schemas/plan";
import { loggedGenerateObject, type GenerationLogContext } from "./logged";
import { DEFAULT_OUTLINE_MODEL } from "./models";
import { appModel, type ResolvedModel } from "./resolve";
import { assignRefs, buildRevisionPrompt, type PlanPromptContext } from "./planPrompt";

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

interface RevisedUnit {
  ref?: string;
  title: string;
  summary: string;
  days: number;
  covers?: CoverRefDraft[];
  materials?: MaterialRefDraft[];
  practiceCovers?: PracticeCoverDraft[];
  practice?: PracticeRefDraft[];
  children?: RevisedUnit[];
}

/**
 * Turns the model's revised tree back into `PlanNode`s. Kept nodes (by ref) keep their id and status; locked nodes
 * are restored verbatim from the original tree; new nodes get temporary ids. Throws when a locked node went missing.
 * With `aliases`, material references come back too: a field the model left out keeps the node's old references,
 * headings keep `covers`, leaves keep `materials`, and ids not in the list are dropped. Practice follows the same
 * rules: leaves keep `practice` (a rewritten list goes through `resolvePracticeRefs`, which drops refused and unknown
 * rows), headings keep `practiceCovers`, and a split week's reservations keep their `task` and `minutes`, its generated
 * ones whatever the model wrote.
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
): PlanNode {
  const byRef = new Map<string, PlanNode>();
  for (const [id, ref] of refs) {
    const node = findNode(original, id);
    if (node) byRef.set(ref, node);
  }
  const topLevel: PlanLevel = original.children?.[0]?.level ?? topLevelFor(weeksOf(original, original, daysPerWeek));
  const seen = new Set<string>();

  const convert = (unit: RevisedUnit, level: PlanLevel): PlanNode => {
    const kept = unit.ref ? byRef.get(unit.ref) : undefined;
    if (kept) seen.add(kept.id);
    if (kept && isLocked(kept, lockBefore)) return cloneTree(kept);
    const below = childLevel(level);
    const children = unit.children && below ? unit.children.map((c) => convert(c, below)) : null;
    const len = spanFor(level, unit.days, kept, daysPerWeek);
    const leafWeek = children === null && level !== "day" && granularity === "week";
    const leaf = children === null && (level === "day" || leafWeek);
    const covers = aliases && unit.covers !== undefined ? keepCoverTiers(resolveCoverRefs(unit.covers, aliases).refs, kept?.covers) : kept?.covers;
    const materials = aliases && unit.materials !== undefined ? resolveMaterialRefs(unit.materials, aliases).refs : kept?.materials;
    const practiceCovers =
      aliases && unit.practiceCovers !== undefined
        ? keptItemless(keepPracticeCovers(resolvePracticeCovers(unit.practiceCovers, aliases, split, SAVED).refs, kept?.practiceCovers, aliases.practice), kept?.practiceCovers, aliases)
        : kept?.practiceCovers;
    const practice =
      aliases && unit.practice !== undefined
        ? keptItemless(resolvePracticeRefs(unit.practice, aliases, split, (materials ?? []).map((r) => r.id), SAVED).refs, kept?.practice, aliases)
        : kept?.practice;
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

function describe(root: PlanNode, node: PlanNode): string {
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
}

/**
 * Runs one revision: the model returns the whole tree with refs, and `applyRevision` reconciles it. The reference
 * checks run tree-wide inside the call's `check` hook, so breaches and the rows dropped for them land on the call's
 * log row; a revision is one large call, so there is no retry.
 */
export async function revisePlanTree(input: RevisePlanInput): Promise<RevisePlanResult> {
  const tree = layout(cloneTree(input.tree));
  const refs = assignRefs(tree);
  const model = input.outlineModel ?? appModel(DEFAULT_OUTLINE_MODEL);
  const aliases = input.materials.length > 0 ? aliasMaterials(input.materials) : undefined;
  let revised: PlanNode | null = null;
  let failure: unknown;
  const check = (object: RevisedTree): string[] => {
    try {
      revised = applyRevision(tree, refs, object, input.lockBefore, input.granularity, aliases, input.hoursPerWeek, input.daysPerWeek, input.split);
    } catch (error) {
      failure = error;
      return [];
    }
    if (!aliases) return [];
    // Practice rows unchanged from the saved tree keep the item and reserved-source rules as facts; new or changed ones breach.
    const checks = treeChecks(revised, input.materials, { granularity: input.granularity, hoursPerWeek: input.hoursPerWeek, daysPerWeek: input.daysPerWeek, split: input.split, original: tree });
    const dropped = dropBreaches(checks.nodes, checks.breaches);
    return [...checks.facts, ...checks.breaches.map((b) => `breach: ${b.text}`), ...dropped];
  };
  const { costUsd } = await loggedGenerateObject(
    {
      model: model.id,
      languageModel: typeof model.model === "string" ? undefined : model.model,
      keyOwner: model.keyOwner,
      schema: revisedTreeSchema,
      prompt: buildRevisionPrompt({ ...input, tree, refs }),
      label: `Revision · ${input.changeRequest.length > 60 ? `${input.changeRequest.slice(0, 57)}…` : input.changeRequest}`,
      check,
    },
    { ...input.log, caller: "outline_revision" },
  );
  if (failure !== undefined) throw failure;
  if (!revised) throw new Error("Revision ended without a tree");
  return { tree: revised, costUsd };
}
