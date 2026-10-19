import { learnerKind } from "@/lib/ai/research/verify";
import { budgetFor, cloneTree, labelOf, parentOf, walk, type PlanNode } from "@/lib/planTree";
import { dayMinutes } from "@/lib/studyTime";
import {
  normalizeCoverRef,
  normalizeMaterialRef,
  type CoverRef,
  type CoverRefDraft,
  type Material,
  type MaterialRef,
  type MaterialRefDraft,
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
}

const ALIAS_RE = /^\[?\s*(m\d+)(?:\.(\d+))?\s*\]?$/i;

export function aliasMaterials(materials: Pick<Material, "id" | "toc">[]): MaterialAliases {
  const toAlias = new Map<string, string>();
  const fromAlias = new Map<string, string>();
  const counts = new Map<string, number>();
  materials.forEach((m, i) => {
    const alias = `M${i + 1}`;
    toAlias.set(m.id, alias);
    fromAlias.set(alias.toLowerCase(), m.id);
    counts.set(m.id, m.toc?.chapters.length ?? 0);
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
 * The leaf's time budget in minutes: a week leaf's hours, or a day's share of the learner's weekly hours (about an
 * hour when the hours are not known).
 */
export function budgetMinutes(node: Pick<PlanNode, "level" | "budgetHours">, hoursPerWeek?: number): number {
  if (node.budgetHours !== null) return node.budgetHours * 60;
  if (node.level !== "day") return 0;
  return hoursPerWeek === undefined ? 60 : dayMinutes(hoursPerWeek);
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

export type BreachKind = "outside" | "overlap" | "whole-book" | "review-before-read" | "over-budget" | "unread-reservation";

/** The breaches a drop can cure: the row goes, the unit keeps the rest. Over-budget and unread reservations stay facts. */
export const DROPPABLE: ReadonlySet<BreachKind> = new Set<BreachKind>(["outside", "overlap", "whole-book", "review-before-read"]);

export interface Breach {
  kind: BreachKind;
  /** Position among the checked units; -1 for the parent's unread reservation. */
  index: number;
  /** "Week 1" */
  unit: string;
  refs: ResolvedAlias[];
  /** The sentence the retry quotes and the admin dock shows. */
  text: string;
}

export interface LevelChecks {
  facts: string[];
  breaches: Breach[];
}

type CheckMaterial = Pick<Material, "id" | "toc" | "minutes"> & { backbone?: boolean };

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
  /** The plan's reading share (0–1); `MUST_SHARE` stands in when it is not decided yet. */
  readingShare?: number | null;
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
 */
export function levelChecks(input: LevelCheckInput): LevelChecks {
  const facts: string[] = [];
  const breaches: Breach[] = [];
  if (input.unknownIds.length > 0) facts.push(`dropped unknown ${[...new Set(input.unknownIds)].join(", ")}`);
  if (input.nodes.length === 0) return { facts, breaches };

  const label = (n: PlanNode) => labelOf(input.root, n);
  const aliases = aliasMaterials(input.materials);
  const byId = new Map(input.materials.map((m) => [m.id, m]));
  const listed = (id: string) => (byId.get(id)?.toc?.chapters.length ?? 0) > 0;
  const share = input.readingShare ?? MUST_SHARE;
  const verb = input.leaves ? "reads" : "reserves";
  const names = (refs: RefLike[]) => formatAliases(refs.map(toResolved), aliases);
  const breach = (kind: BreachKind, index: number, unit: string, refs: RefLike[], text: string) => breaches.push({ kind, index, unit, refs: refs.map(toResolved), text });

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

  // What every other unit in the plan reads or reserves, keyed to the unit that holds it.
  const taken = new Map<string, string>();
  walk(input.root, (n) => {
    if (n.id === input.root.id || skip.has(n.id)) return;
    for (const r of refsOf(n).filter(isRead)) if (!taken.has(refKey(r))) taken.set(refKey(r), label(n));
  });
  // Siblings: a heading holds a resource exclusively; consecutive leaves may share one that is too long for one of them.
  const siblingLast = new Map<string, number>();
  const sizeOf = (r: RefLike): number | null => (r.chapter ? (chapterAt(byId.get(r.id)?.toc, r.chapter)?.minutes ?? null) : (byId.get(r.id)?.minutes ?? null));
  const mayShare = (node: PlanNode, r: RefLike, index: number): boolean => {
    if (!input.leaves) return false;
    const last = siblingLast.get(refKey(r));
    if (last === undefined || last !== index - 1) return false;
    const size = sizeOf(r);
    const budget = node.budgetHours === null && input.hoursPerWeek === undefined ? 0 : budgetMinutes(node, input.hoursPerWeek);
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

  const withRefs = input.nodes.filter((n) => refsOf(n).length > 0);
  if (input.leaves && withRefs.length > 0) {
    const noMust = input.nodes.filter((n) => !(n.materials ?? []).some((r) => r.tier === "must"));
    if (noMust.length > 0) facts.push(`no must: ${noMust.map(label).join(", ")}`);
  }

  input.nodes.forEach((node, index) => {
    const unit = label(node);
    const refs = refsOf(node);
    const reads = refs.filter(isRead);
    const whole = reads.filter((r) => !r.chapter && listed(r.id));
    if (whole.length > 0) breach("whole-book", index, unit, whole, `${unit} refers to ${names(whole)} as a whole; use its chapters`);
    const chaptered = reads.filter((r) => !whole.includes(r));
    if (hasReservation) {
      const outside = chaptered.filter((r) => !reservedKeys.has(refKey(r)) && !reservedWhole.has(r.id));
      if (outside.length > 0) breach("outside", index, unit, outside, `${unit} ${verb} ${names(outside)}, which ${label(parentNode!)} did not reserve`);
    }
    const byHolder = new Map<string, RefLike[]>();
    for (const r of chaptered) {
      const sibling = siblingLast.get(refKey(r));
      const holder = taken.get(refKey(r)) ?? (sibling !== undefined && !mayShare(node, r, index) ? label(input.nodes[sibling]) : undefined);
      if (holder) byHolder.set(holder, [...(byHolder.get(holder) ?? []), r]);
    }
    for (const [holder, rs] of byHolder) breach("overlap", index, unit, rs, `${unit} ${verb} ${names(rs)}, which ${holder} holds`);
    for (const r of reads) siblingLast.set(refKey(r), index);

    const unread = refs.filter((r) => !isRead(r) && !readBefore(node, refKey(r)));
    if (unread.length > 0) breach("review-before-read", index, unit, unread, `${unit} reviews ${names(unread)}, which no earlier unit reads`);

    if (input.leaves) {
      // Without the learner's hours only week leaves carry a budget; with them, days do too.
      if (withRefs.length === 0 || (node.budgetHours === null && input.hoursPerWeek === undefined)) return;
      const budget = budgetMinutes(node, input.hoursPerWeek);
      if (budget <= 0) return;
      const { must, should } = tierMinutes(node.materials);
      if (must + should > budget) facts.push(`${unit} over budget: ${must + should} of ${budget} min`);
      if (must > budget * share * SHARE_TOLERANCE + 10) {
        breach("over-budget", index, unit, [], `${unit}'s must-reading is ${must} min against a budget of about ${Math.round(budget * share)} min`);
      }
    } else {
      const known = reads.reduce((sum, r) => sum + (r.chapter ? (chapterAt(byId.get(r.id)?.toc, r.chapter)?.minutes ?? 0) : (byId.get(r.id)?.minutes ?? 0)), 0);
      const budget = budgetFor(node.len, input.hoursPerWeek) * 60 * share;
      if (known > budget * SHARE_TOLERANCE) {
        breach("over-budget", index, unit, [], `${unit} reserves about ${known} min of reading against a budget of about ${Math.round(budget)} min`);
      }
    }
  });

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
export function treeChecks(root: PlanNode, materials: CheckMaterial[], opts: { hoursPerWeek?: number; readingShare?: number | null }): LevelChecks & { nodes: PlanNode[] } {
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
    const leaves = group.every((g) => g.children === null && !g.covers);
    const out = levelChecks({ root, nodes: group, leaves, top: n.id === root.id, materials, unknownIds: [], ...opts });
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
    const keys = new Set(b.refs.map(refKey));
    if (node.covers) {
      node.covers = node.covers.filter((r) => !keys.has(refKey(r)));
      if (node.covers.length === 0) delete node.covers;
    }
    if (node.materials) {
      node.materials = node.materials.filter((r) => !keys.has(refKey(r)));
      if (node.materials.length === 0) delete node.materials;
    }
    const aliases = b.refs.map((r) => (r.chapter ? `${r.id}#${r.chapter}` : r.id));
    out.push(`dropped ${b.text.match(/^\S+ \S+ (?:reads |reserves |reviews |refers to )?(.+?)(?:,| as a whole)/)?.[1] ?? aliases.join(", ")} from ${b.unit}: ${b.kind}`);
  }
  return out;
}

/** Where a material is used, for the remove-material confirmation. */
export function assignmentsOf(root: PlanNode, id: string): { node: PlanNode; label: string; role: "covers" | "assigned" }[] {
  const out: { node: PlanNode; label: string; role: "covers" | "assigned" }[] = [];
  walk(root, (n) => {
    if (n.id === root.id) return;
    if (n.covers?.some((r) => r.id === id)) out.push({ node: n, label: labelOf(root, n), role: "covers" });
    if (n.materials?.some((r) => r.id === id)) out.push({ node: n, label: labelOf(root, n), role: "assigned" });
  });
  return out;
}

/** A copy of the tree without any reference to `id`. */
export function removeMaterialRefs(root: PlanNode, id: string): PlanNode {
  const next = cloneTree(root);
  walk(next, (n) => {
    if (n.covers) n.covers = n.covers.filter((r) => r.id !== id);
    if (n.materials) n.materials = n.materials.filter((r) => r.id !== id);
    if (n.covers?.length === 0) delete n.covers;
    if (n.materials?.length === 0) delete n.materials;
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
  walk(next, (n) => {
    const covers = map(n.covers);
    const materials = map(n.materials);
    if (covers) n.covers = covers;
    else delete n.covers;
    if (materials) n.materials = materials;
    else delete n.materials;
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
