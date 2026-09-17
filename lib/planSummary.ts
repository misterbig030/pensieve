import {
  highestLevel,
  labelOf,
  leavesOf,
  parentOf,
  walk,
  type PlanLevel,
  type PlanNode,
} from "./planTree";

/** The plan summary card text. Deterministic so it costs nothing and never drifts from the tree. */
export function summarizePlan(root: PlanNode, topic: string, note?: string): string {
  const tops = root.children ?? [];
  if (tops.length === 0) return "";
  const n = root.len;
  const leaves = leavesOf(root);
  const weeks = Math.ceil(n / 7);
  const level = tops[0].level;
  const first = leaves[0];
  const last = leaves[leaves.length - 1];
  const lastTitle = last && last.end === n ? last.title : tops[tops.length - 1].title;
  const titles = tops.map((t) => t.title).join(", ");
  const base =
    level === "day"
      ? `${n} days on ${topic}, one day at a time: ${titles}. Opens with "${first.title}" and closes on "${lastTitle}".`
      : `${n} days on ${topic}, about ${weeks} week${weeks === 1 ? "" : "s"}, in ${tops.length} ${level}s: ${titles}. Opens with "${first ? first.title : tops[0].title}" and closes on "${lastTitle}".`;
  return note ? `${base} ${note}` : base;
}

/** Turns a change note into the "Latest change: …" clause appended to the summary. */
export function latestChangeNote(note: string): string {
  const trimmed = note.trim();
  if (!trimmed) return "";
  return `Latest change: ${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
}

export interface ChangedNodes {
  ids: string[];
  level: PlanLevel;
  tags: string[];
}

function fingerprint(node: PlanNode): string {
  return `${node.level}|${node.title}|${node.summary}|${node.len}|${node.children ? node.children.length : "-"}`;
}

/**
 * Nodes in `next` whose level, title, summary, span or child count differ from anything in `prev`. A group whose
 * children changed is reported through its children, not itself, so the tags point at the smallest changed unit.
 * If nothing is new but the shape changed (pure removal), the node now at the first divergence is reported.
 */
export function diffChangedNodes(prev: PlanNode, next: PlanNode): ChangedNodes {
  const seen = new Set<string>();
  walk(prev, (n) => {
    if (n.id !== prev.id) seen.add(fingerprint(n));
  });
  const changed: PlanNode[] = [];
  walk(next, (n) => {
    if (n.id === next.id) return;
    if (!seen.has(fingerprint(n))) changed.push(n);
  });
  // Keep the outermost changed nodes: a changed group already covers its changed children.
  const outer = changed.filter((n) => {
    let p = parentOf(next, n.id);
    while (p && p.id !== next.id) {
      if (changed.includes(p)) return false;
      p = parentOf(next, p.id);
    }
    return true;
  });
  const picked = outer.length > 0 ? outer : leavesOf(prev).length === leavesOf(next).length ? movedNodes(prev, next) : seamNodes(prev, next);
  const level = highestLevel(picked.map((n) => n.level));
  const tags = picked.map((n) => tagFor(next, n));
  return { ids: picked.map((n) => n.id), level, tags: dedupe(tags) };
}

function seamNodes(prev: PlanNode, next: PlanNode): PlanNode[] {
  const prevLeaves = leavesOf(prev);
  const nextLeaves = leavesOf(next);
  const seam = nextLeaves.findIndex((n, i) => !prevLeaves[i] || fingerprint(prevLeaves[i]) !== fingerprint(n));
  if (seam === -1) return nextLeaves.length > 0 ? [nextLeaves[nextLeaves.length - 1]] : [];
  return [nextLeaves[seam]];
}

/** Nodes whose content is unchanged but whose position among their siblings moved (a swap or a reorder). */
function movedNodes(prev: PlanNode, next: PlanNode): PlanNode[] {
  const positions = new Map<string, number>();
  walk(prev, (n, _p, i) => {
    if (n.id !== prev.id) positions.set(fingerprint(n), i);
  });
  const moved: PlanNode[] = [];
  walk(next, (n, _p, i) => {
    if (n.id === next.id) return;
    const was = positions.get(fingerprint(n));
    if (was !== undefined && was !== i) moved.push(n);
  });
  return moved.filter((n) => {
    let p = parentOf(next, n.id);
    while (p && p.id !== next.id) {
      if (moved.includes(p)) return false;
      p = parentOf(next, p.id);
    }
    return true;
  });
}

/** "Week 2 · Day 9" for a nested day, otherwise the node's own label. */
export function tagFor(root: PlanNode, node: PlanNode): string {
  const own = labelOf(root, node);
  if (node.level !== "day") return own;
  const parent = parentOf(root, node.id);
  return parent && parent.id !== root.id ? `${labelOf(root, parent)} · ${own}` : own;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
