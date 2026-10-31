import { labelOf, walk, type PlanNode } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";

export interface UsedMaterial {
  material: Material;
  /** The chapters and practice items the selected unit uses, as "ch. 1–2 · items 3–8"; empty when the refs name neither. */
  part: string;
}

export interface PlacedMaterial {
  material: Material;
  /** Where it comes in the plan: "Week 3", "from Week 3", "Week 1 · Day 5". */
  place: string;
}

/** The track's materials around the selected unit: what it uses, what comes later, what came before, and what no unit uses. */
export interface MaterialPlacement {
  used: UsedMaterial[];
  later: PlacedMaterial[];
  earlier: PlacedMaterial[];
  unused: Material[];
}

interface Use {
  node: PlanNode;
  chapter: number | null;
  items: [number, number] | null;
}

/** A unit's place from the top of the plan: "Week 3", "Week 1 · Day 5", "Month 2 · Week 1". */
export function placeLabel(root: PlanNode, node: PlanNode): string {
  return pathTo(root, node)
    .map((n) => labelOf(root, n))
    .join(" · ");
}

/** The nodes from below the root down to `node`, inclusive. */
function pathTo(root: PlanNode, node: PlanNode): PlanNode[] {
  const parents = new Map<string, PlanNode | null>();
  walk(root, (n, parent) => parents.set(n.id, parent));
  const path: PlanNode[] = [];
  for (let n: PlanNode | null = node; n && n.id !== root.id; n = parents.get(n.id) ?? null) path.unshift(n);
  return path;
}

/**
 * Sorts the track's materials around the selected unit. A use is any unit below the root whose reservations or rows
 * name the material. One inside the selected unit makes it used; otherwise its uses after the unit make it later and its
 * uses before make it earlier. A reservation on a heading above the selected unit says nothing about the unit itself, so
 * a material reserved there and nowhere else is listed as later, under that heading.
 */
export function materialPlacement(root: PlanNode, materials: Material[], selected: PlanNode): MaterialPlacement {
  const parents = new Map<string, PlanNode | null>();
  const uses = new Map<string, Use[]>();
  const add = (id: string | null, use: Use) => {
    if (id) uses.set(id, [...(uses.get(id) ?? []), use]);
  };
  walk(root, (node, parent) => {
    parents.set(node.id, parent);
    if (node.id === root.id) return;
    for (const r of node.covers ?? []) add(r.id, { node, chapter: r.chapter ?? null, items: null });
    for (const r of node.materials ?? []) add(r.id, { node, chapter: r.chapter ?? null, items: null });
    for (const r of [...(node.practiceCovers ?? []), ...(node.practice ?? [])]) add(r.id, { node, chapter: null, items: r.itemFrom ? [r.itemFrom, r.itemTo ?? r.itemFrom] : null });
  });

  const inside = new Set<string>();
  walk(selected, (n) => inside.add(n.id));
  const above = new Set<string>();
  for (let n = parents.get(selected.id) ?? null; n && n.id !== root.id; n = parents.get(n.id) ?? null) above.add(n.id);

  const labels = new Map<string, string>();
  const label = (n: PlanNode) => labels.get(n.id) ?? labels.set(n.id, placeLabel(root, n)).get(n.id)!;
  // A use is named at the selected unit's level: a day by its day, a week by its week, and a heading not yet planned that
  // deep by itself.
  const place = (n: PlanNode) => {
    for (let at: PlanNode | null = n; at && at.id !== root.id; at = parents.get(at.id) ?? null) if (at.level === selected.level) return label(at);
    return label(n);
  };

  const used: (UsedMaterial & { at: number; i: number })[] = [];
  const later: (PlacedMaterial & { at: number; i: number })[] = [];
  const earlier: (PlacedMaterial & { at: number; i: number })[] = [];
  const unused: Material[] = [];
  materials.forEach((material, i) => {
    const all = uses.get(material.id) ?? [];
    const mine = all.filter((u) => inside.has(u.node.id));
    const after = all.filter((u) => !inside.has(u.node.id) && !above.has(u.node.id) && u.node.start > selected.end).sort((a, b) => a.node.start - b.node.start);
    const before = all.filter((u) => !inside.has(u.node.id) && !above.has(u.node.id) && u.node.end < selected.start).sort((a, b) => b.node.end - a.node.end);
    const reserved = all.filter((u) => above.has(u.node.id));
    if (mine.length > 0) {
      used.push({ material, part: partOf(mine), at: Math.min(...mine.map((u) => u.node.start)), i });
    } else if (after.length > 0) {
      const places = [...new Set(after.map((u) => place(u.node)))];
      later.push({ material, place: `${places.length > 1 ? "from " : ""}${places[0]}`, at: after[0].node.start, i });
    } else if (before.length > 0) {
      earlier.push({ material, place: place(before[0].node), at: before[0].node.end, i });
    } else if (reserved.length > 0) {
      later.push({ material, place: label(reserved[0].node), at: Infinity, i });
    } else {
      unused.push(material);
    }
  });

  const byAt = (a: { at: number; i: number }, b: { at: number; i: number }) => a.at - b.at || a.i - b.i;
  const placed = ({ material, place }: PlacedMaterial) => ({ material, place });
  return {
    used: used.sort(byAt).map(({ material, part }) => ({ material, part })),
    later: later.sort(byAt).map(placed),
    earlier: earlier.sort((a, b) => b.at - a.at || a.i - b.i).map(placed),
    unused,
  };
}

/** "ch. 1–2, 5 · items 3–8": the chapters and item runs a unit's rows name. */
function partOf(uses: Use[]): string {
  const chapters = [...new Set(uses.flatMap((u) => (u.chapter ? [u.chapter] : [])))].sort((a, b) => a - b);
  const items = mergeRuns(uses.flatMap((u) => (u.items ? [u.items] : [])));
  return [
    chapters.length > 0 && `ch. ${runs(chapters.map((c) => [c, c] as [number, number])).join(", ")}`,
    items.length > 0 && `${items.length === 1 && items[0][0] === items[0][1] ? "item" : "items"} ${runs(items).join(", ")}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function mergeRuns(list: [number, number][]): [number, number][] {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = out.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

function runs(list: [number, number][]): string[] {
  return mergeRuns(list).map(([from, to]) => (from === to ? String(from) : `${from}–${to}`));
}
