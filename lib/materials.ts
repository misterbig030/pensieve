import { learnerKind } from "@/lib/ai/research/verify";
import { cloneTree, labelOf, walk, type PlanNode } from "@/lib/planTree";
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
} from "@/lib/schemas/material";
import type { SourceInput } from "@/lib/schemas/source";

/**
 * Prompts always call materials `M1…Mn` in list order, whatever their real ids are (short ids while drafting, uuids
 * once saved), so the model never has to echo a uuid. These map between the two.
 */
export interface MaterialAliases {
  alias(id: string): string | undefined;
  resolve(alias: string): string | undefined;
}

export function aliasMaterials(materials: Pick<Material, "id">[]): MaterialAliases {
  const toAlias = new Map<string, string>();
  const fromAlias = new Map<string, string>();
  materials.forEach((m, i) => {
    const alias = `M${i + 1}`;
    toAlias.set(m.id, alias);
    fromAlias.set(alias.toLowerCase(), m.id);
  });
  return {
    alias: (id) => toAlias.get(id),
    resolve: (alias) => fromAlias.get(alias.trim().replace(/^\[|\]$/g, "").toLowerCase()),
  };
}

/** Resolves what the model wrote to real ids. Unknown ids are dropped and returned so the caller can report them. */
export function resolveMaterialRefs(
  refs: MaterialRefDraft[] | undefined,
  aliases: MaterialAliases,
): { refs: MaterialRef[]; unknown: string[] } {
  const out: MaterialRef[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const draft of refs ?? []) {
    const id = aliases.resolve(draft.id);
    if (!id) {
      unknown.push(draft.id);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...normalizeMaterialRef(draft), id });
  }
  return { refs: out, unknown };
}

export function resolveCoverRefs(refs: CoverRefDraft[] | undefined, aliases: MaterialAliases): { refs: CoverRef[]; unknown: string[] } {
  const out: CoverRef[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const draft of refs ?? []) {
    const id = aliases.resolve(draft.id);
    if (!id) {
      unknown.push(draft.id);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...normalizeCoverRef(draft), id });
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

/** The leaf's time budget in minutes: a week leaf's hours, or about an hour for a day. */
export function budgetMinutes(node: Pick<PlanNode, "level" | "budgetHours">): number {
  if (node.budgetHours !== null) return node.budgetHours * 60;
  return node.level === "day" ? 60 : 0;
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

export interface LevelCheckInput {
  root: PlanNode;
  /** The units this level placed, in order, already in `root`. */
  nodes: PlanNode[];
  leaves: boolean;
  /** Whether these are the plan's top-level units. */
  top: boolean;
  backboneId: string | null;
  unknownIds: string[];
}

/**
 * The checks in code that run after each drafted level. They never change the plan; they become facts in the
 * admin panel and the eval: unknown ids dropped, leaves over budget or without a must, backbone chapters out of
 * order, and backbone chapters no top-level heading reserves.
 */
export function levelFacts(input: LevelCheckInput): string[] {
  const facts: string[] = [];
  if (input.unknownIds.length > 0) facts.push(`dropped unknown ${[...new Set(input.unknownIds)].join(", ")}`);
  const label = (n: PlanNode) => labelOf(input.root, n);

  if (input.leaves) {
    const withRefs = input.nodes.filter((n) => (n.materials?.length ?? 0) > 0);
    if (withRefs.length > 0) {
      const noMust = input.nodes.filter((n) => !(n.materials ?? []).some((r) => r.tier === "must"));
      if (noMust.length > 0) facts.push(`no must: ${noMust.map(label).join(", ")}`);
      for (const n of input.nodes) {
        if (n.budgetHours === null) continue;
        const total = (n.materials ?? []).reduce((sum, r) => sum + (r.minutes ?? 0), 0);
        if (total > n.budgetHours * 60) facts.push(`${label(n)} over budget: ${total} of ${n.budgetHours * 60} min`);
      }
    }
  }

  if (input.backboneId) {
    const id = input.backboneId;
    const steps: ChapterStep[] = input.nodes.map((n) => {
      const refs = input.leaves ? n.materials : n.covers;
      const note = refs?.find((r) => r.id === id)?.note;
      return { label: label(n), chapters: parseChapters(note) };
    });
    // Start from where the plan before these units left the backbone, so an expansion continues in order.
    const before = chaptersBefore(input.root, input.nodes[0], id);
    facts.push(...chapterRegressions([{ label: "earlier units", chapters: before }, ...steps]));
    if (input.top && !input.leaves) {
      const gaps = chapterGaps(steps.flatMap((s) => s.chapters));
      if (gaps.length > 0) facts.push(`backbone ch. ${formatChapters(gaps)} not reserved`);
    }
  }
  return facts;
}

/** Backbone chapters read by leaves that come before `node` in plan order. */
function chaptersBefore(root: PlanNode, node: PlanNode | undefined, backboneId: string): number[] {
  if (!node) return [];
  const out: number[] = [];
  let reached = false;
  walk(root, (n) => {
    if (reached || n.id === root.id) return;
    if (n.id === node.id) {
      reached = true;
      return;
    }
    if (n.children === null && n.end < node.start) out.push(...parseChapters(n.materials?.find((r) => r.id === backboneId)?.note));
  });
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
