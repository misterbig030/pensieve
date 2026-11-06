/**
 * The outline task's code checks: pure functions over a level's units (what the model wrote as `UnitDraft`s, or the
 * nodes the app made of them). Nothing here calls a model; the task's criteria wire them in.
 */
import { aliasMaterials, refKey, type Breach, type BreachKind } from "@/lib/materials";
import type { PlanNode } from "@/lib/planTree";
import { itemMinutes } from "@/lib/practice";
import { chapterAt, type Material } from "@/lib/schemas/material";
import type { UnitDraft } from "@/lib/schemas/plan";

/** A reservation may run from half to one and a half times the size the material gives it. */
export const SIZE_TOLERANCE: [number, number] = [0.5, 1.5];

/** The breaches of the asked kinds. */
export function breachesOf(breaches: Breach[], kinds: BreachKind[]): Breach[] {
  return breaches.filter((b) => kinds.includes(b.kind));
}

/** "Day 2" by position among the level's units, as `labelOf` names a node. */
function unitLabel(nodes: PlanNode[], index: number): string {
  const level = nodes[index].level;
  return `${level[0].toUpperCase()}${level.slice(1)} ${index + 1}`;
}

/** Whether the size `total` is outside the tolerance around `size`. */
function outsideSize(total: number, size: number): boolean {
  return total < size * SIZE_TOLERANCE[0] || total > size * SIZE_TOLERANCE[1];
}

/**
 * Where units go back on the order of a material: a chapter that comes after a later chapter of the same material in
 * an earlier unit, or a practice item after a later item of its source. Reviews are the learner's choice and are not
 * ordered. Ids are the nodes' own.
 */
export function orderBreaks(nodes: PlanNode[], leaf: boolean): string[] {
  const out: string[] = [];
  const furthestChapter = new Map<string, { n: number; at: number }>();
  const furthestItem = new Map<string, { n: number; at: number }>();
  nodes.forEach((node, at) => {
    const chapters = (leaf ? node.materials : node.covers) ?? [];
    const practice = (leaf ? node.practice : node.practiceCovers) ?? [];
    const seenChapters: [string, number][] = [];
    const seenItems: [string, number][] = [];
    for (const r of chapters) {
      if (r.activity === "review" || !r.chapter) continue;
      const before = furthestChapter.get(r.id);
      if (before && before.at < at && r.chapter < before.n) {
        out.push(`${r.id} chapter ${r.chapter} in ${unitLabel(nodes, at)} after chapter ${before.n} in ${unitLabel(nodes, before.at)}`);
      }
      seenChapters.push([r.id, r.chapter]);
    }
    for (const r of practice) {
      if (!r.id || !r.itemFrom) continue;
      const before = furthestItem.get(r.id);
      if (before && before.at < at && r.itemFrom < before.n) {
        out.push(`${r.id} item ${r.itemFrom} in ${unitLabel(nodes, at)} after item ${before.n} in ${unitLabel(nodes, before.at)}`);
      }
      seenItems.push([r.id, r.itemTo ?? r.itemFrom]);
    }
    for (const [id, n] of seenChapters) if (n > (furthestChapter.get(id)?.n ?? 0)) furthestChapter.set(id, { n, at });
    for (const [id, n] of seenItems) if (n > (furthestItem.get(id)?.n ?? 0)) furthestItem.set(id, { n, at });
  });
  return out;
}

/** The materials no unit reserves: a chapter or an item reserves its material. */
export function unreserved(nodes: PlanNode[], materials: Material[], leaf: boolean): Material[] {
  const held = new Set<string>();
  for (const node of nodes) {
    for (const r of (leaf ? node.materials : node.covers) ?? []) held.add(r.id);
    for (const r of (leaf ? node.practice : node.practiceCovers) ?? []) if (r.id) held.add(r.id);
  }
  return materials.filter((m) => !held.has(m.id));
}

const ID_IN_TEXT = /\bM\d+(?:\.i?\d+)?\b/g;

/** Material ids the units' prose names (`M1`, `M1.3`, `M4.i12`): the prompt's aliases leaking into what the learner reads. */
export function idsInText(units: UnitDraft[]): string[] {
  const out: string[] = [];
  for (const u of units) {
    const texts = [
      u.title,
      u.summary,
      ...(u.covers ?? []).map((r) => r.note),
      ...(u.materials ?? []).map((r) => r.note),
      ...(u.practiceCovers ?? []).map((r) => r.note),
      ...(u.practice ?? []).flatMap((r) => [r.task, r.done]),
    ];
    for (const t of texts) if (t) out.push(...(t.match(ID_IN_TEXT) ?? []));
  }
  return out;
}

export interface SizeCheck {
  /** Reservations whose material gives a size. */
  sized: number;
  /** Reservations whose material gives none. */
  unsized: number;
  /** One line for each sized reservation outside `SIZE_TOLERANCE`. */
  off: string[];
}

/**
 * The minutes the model gave readings and practice items against what the material says they take. Rows for one
 * chapter (or one whole resource) are summed across the level, as a chapter may be read over several units; a
 * practice row naming one item is compared with that item.
 */
export function minutesOffSize(units: UnitDraft[], materials: Material[]): SizeCheck {
  const aliases = aliasMaterials(materials);
  const byId = new Map(materials.map((m) => [m.id, m]));
  const groups = new Map<string, { id: string; chapter: number | null; total: number }>();
  const result: SizeCheck = { sized: 0, unsized: 0, off: [] };
  for (const u of units) {
    for (const r of u.materials ?? []) {
      const ref = aliases.resolve(r.id);
      if (!ref) continue;
      const key = refKey(ref);
      const group = groups.get(key) ?? { id: ref.id, chapter: ref.chapter, total: 0 };
      group.total += r.minutes;
      groups.set(key, group);
    }
    for (const r of u.practice ?? []) {
      const ref = r.id ? aliases.resolve(r.id) : undefined;
      if (!ref) continue;
      const format = aliases.practice(ref.id);
      const item = ref.item === undefined ? undefined : aliases.item(ref.id, ref.item);
      if (!format || !item) {
        result.unsized += 1;
        continue;
      }
      const size = itemMinutes(format, item);
      result.sized += 1;
      if (outsideSize(r.minutes, size)) result.off.push(`${aliases.alias(ref.id, { item: ref.item! })} ${r.minutes} min against ${size}`);
    }
  }
  for (const g of groups.values()) {
    const m = byId.get(g.id);
    const size = g.chapter ? chapterAt(m?.toc, g.chapter)?.minutes : m?.minutes;
    if (!size) {
      result.unsized += 1;
      continue;
    }
    result.sized += 1;
    if (outsideSize(g.total, size)) result.off.push(`${aliases.alias(g.id, g.chapter)} ${g.total} min against ${size}`);
  }
  return result;
}

/**
 * Whether each heading's reserved chapters, summed, fit the reading minutes its `time` sets aside. A heading with a cover
 * that gives no size (a whole resource, or a chapter the list does not size) counts as unsized.
 */
export function setAsideOffSize(nodes: PlanNode[], materials: Material[]): SizeCheck {
  const byId = new Map(materials.map((m) => [m.id, m]));
  const result: SizeCheck = { sized: 0, unsized: 0, off: [] };
  nodes.forEach((node, at) => {
    const covers = (node.covers ?? []).filter((c) => c.activity !== "review");
    if (!node.time || covers.length === 0) return;
    const sizes = covers.map((c) => (c.chapter ? chapterAt(byId.get(c.id)?.toc, c.chapter)?.minutes : undefined));
    if (sizes.some((s) => !s)) {
      result.unsized += 1;
      return;
    }
    const total = sizes.reduce<number>((sum, s) => sum + (s ?? 0), 0);
    result.sized += 1;
    if (outsideSize(total, node.time.reading)) result.off.push(`${unitLabel(nodes, at)} reserves ${total} min against ${node.time.reading} set aside`);
  });
  return result;
}
