import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "./client";
import {
  checkIns,
  dailyContent,
  nodeMaterials,
  planNodes,
  sources,
  tracks,
  type NewNodeMaterialRow,
  type NewPlanNodeRow,
  type NodeMaterialRow,
  type PlanNodeRow,
} from "./schema";
import { makeRoot, walk, type PlanNode } from "@/lib/planTree";
import type { CoverRef, MaterialRef } from "@/lib/schemas/material";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Groups a track's `node_materials` rows into each node's covers and Read table, in row order. */
export function refsByNode(rows: Pick<NodeMaterialRow, "nodeId" | "sourceId" | "role" | "tier" | "minutes" | "note" | "position">[]) {
  const out = new Map<string, { covers: CoverRef[]; materials: MaterialRef[] }>();
  for (const row of [...rows].sort((a, b) => a.position - b.position)) {
    const entry = out.get(row.nodeId) ?? { covers: [], materials: [] };
    if (row.role === "covers") entry.covers.push({ id: row.sourceId, note: row.note });
    else entry.materials.push({ id: row.sourceId, tier: row.tier ?? "should", minutes: row.minutes, note: row.note });
    out.set(row.nodeId, entry);
  }
  return out;
}

/** Builds the in-memory tree from a track's rows. Every stored node is present; a childless node is a leaf. */
export function rowsToTree(rows: PlanNodeRow[], materialRows: NodeMaterialRow[] = []): PlanNode {
  const refs = refsByNode(materialRows);
  const byParent = new Map<string | null, PlanNodeRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.parentId) ?? [];
    list.push(row);
    byParent.set(row.parentId, list);
  }
  const build = (row: PlanNodeRow): PlanNode => {
    const kids = (byParent.get(row.id) ?? []).sort((a, b) => a.position - b.position);
    return {
      id: row.id,
      level: row.level,
      title: row.title,
      summary: row.summary,
      len: row.len,
      status: row.status,
      budgetHours: row.budgetHours,
      manualSplit: row.manualSplit,
      children: kids.length > 0 ? kids.map(build) : null,
      ...(refs.get(row.id)?.covers.length ? { covers: refs.get(row.id)!.covers } : {}),
      ...(refs.get(row.id)?.materials.length ? { materials: refs.get(row.id)!.materials } : {}),
      start: 1,
      end: row.len,
    };
  };
  const tops = (byParent.get(null) ?? []).sort((a, b) => a.position - b.position).map(build);
  return makeRoot(tops);
}

/** Every `node_materials` row of a track. */
export async function getTrackNodeMaterials(trackId: string, database: Pick<typeof db, "select"> = db): Promise<NodeMaterialRow[]> {
  return database
    .select({
      nodeId: nodeMaterials.nodeId,
      sourceId: nodeMaterials.sourceId,
      role: nodeMaterials.role,
      tier: nodeMaterials.tier,
      minutes: nodeMaterials.minutes,
      note: nodeMaterials.note,
      position: nodeMaterials.position,
    })
    .from(nodeMaterials)
    .innerJoin(planNodes, eq(nodeMaterials.nodeId, planNodes.id))
    .where(eq(planNodes.trackId, trackId));
}

export async function getPlanTree(trackId: string): Promise<PlanNode> {
  const [rows, materialRows] = await Promise.all([
    db.query.planNodes.findMany({ where: eq(planNodes.trackId, trackId), orderBy: [asc(planNodes.position)] }),
    getTrackNodeMaterials(trackId),
  ]);
  return rowsToTree(rows, materialRows);
}

/**
 * A node's references as rows. Leaves keep their Read table (`assigned`), everything else its reservation
 * (`covers`); a source appears at most once per node. Only ids in `sourceIds` are written.
 */
export function refRows(nodeId: string, node: Pick<PlanNode, "covers" | "materials" | "children">, sourceIds: ReadonlySet<string>): NewNodeMaterialRow[] {
  const rows: NewNodeMaterialRow[] = [];
  const seen = new Set<string>();
  const assigned = node.children === null ? (node.materials ?? []) : [];
  for (const [i, ref] of assigned.entries()) {
    if (!sourceIds.has(ref.id) || seen.has(ref.id)) continue;
    seen.add(ref.id);
    rows.push({ nodeId, sourceId: ref.id, role: "assigned", tier: ref.tier, minutes: ref.minutes, note: ref.note, position: i });
  }
  const covers = [...(node.covers ?? []), ...(node.children !== null ? (node.materials ?? []) : [])];
  for (const [i, ref] of covers.entries()) {
    if (!sourceIds.has(ref.id) || seen.has(ref.id)) continue;
    seen.add(ref.id);
    rows.push({ nodeId, sourceId: ref.id, role: "covers", tier: null, minutes: null, note: ref.note, position: i });
  }
  return rows;
}

/**
 * Flattens a tree into insertable rows, minting uuids for temporary ids and remapping parents accordingly. With
 * `sourceIds`, each node's references come out as `node_materials` rows under the same ids.
 */
export function flattenTree(trackId: string, root: PlanNode, sourceIds: ReadonlySet<string> = new Set()): { nodes: NewPlanNodeRow[]; materials: NewNodeMaterialRow[] } {
  const rows: NewPlanNodeRow[] = [];
  const materials: NewNodeMaterialRow[] = [];
  const ids = new Map<string, string>();
  const idFor = (node: PlanNode) => {
    let id = ids.get(node.id);
    if (!id) {
      id = isUuid(node.id) ? node.id : crypto.randomUUID();
      ids.set(node.id, id);
    }
    return id;
  };
  walk(root, (node, parent, index) => {
    if (node.id === root.id) return;
    rows.push({
      id: idFor(node),
      trackId,
      parentId: parent && parent.id !== root.id ? idFor(parent) : null,
      position: index,
      level: node.level,
      title: node.title,
      summary: node.summary,
      len: node.len,
      status: node.status,
      budgetHours: node.budgetHours,
      manualSplit: node.manualSplit,
    });
    materials.push(...refRows(idFor(node), node, sourceIds));
  });
  return { nodes: rows, materials };
}

export function treeToRows(trackId: string, root: PlanNode): NewPlanNodeRow[] {
  return flattenTree(trackId, root).nodes;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Inserts a whole tree and its references. `sourceIds` are the track's source uuids; other references are dropped. */
export async function insertPlanTree(tx: Tx, trackId: string, root: PlanNode, sourceIds: ReadonlySet<string> = new Set()): Promise<void> {
  const { nodes: rows, materials } = flattenTree(trackId, root, sourceIds);
  // Parents are always emitted before their children by `walk`, so one ordered insert satisfies the self-reference.
  for (let i = 0; i < rows.length; i += 200) {
    await tx.insert(planNodes).values(rows.slice(i, i + 200));
  }
  for (let i = 0; i < materials.length; i += 200) {
    await tx.insert(nodeMaterials).values(materials.slice(i, i + 200));
  }
}

async function trackSourceIds(tx: Tx, trackId: string): Promise<Set<string>> {
  const rows = await tx.query.sources.findMany({ where: eq(sources.trackId, trackId), columns: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/**
 * Adjust-mode confirm: nodes that still exist keep their rows (and so their content and check-ins); nodes missing
 * from the new tree are deleted; new nodes are inserted. Positions and parents are rewritten from the tree. With
 * `keepMaterialIds`, the track's materials not listed are removed, and their references with them. References are
 * rewritten from the tree; any that point outside the track's materials are dropped.
 */
export async function replacePlanTree(trackId: string, userId: string, root: PlanNode, keepMaterialIds?: string[]): Promise<void> {
  const track = await db.query.tracks.findFirst({
    where: and(eq(tracks.id, trackId), eq(tracks.userId, userId)),
    columns: { id: true },
  });
  if (!track) throw new Error("Track not found for this user");

  await db.transaction(async (tx) => {
    if (keepMaterialIds) {
      const existingSources = await trackSourceIds(tx, trackId);
      const keep = new Set(keepMaterialIds);
      const removed = [...existingSources].filter((id) => !keep.has(id));
      if (removed.length > 0) await tx.delete(sources).where(and(eq(sources.trackId, trackId), inArray(sources.id, removed)));
    }
    const sourceIds = await trackSourceIds(tx, trackId);
    const { nodes: rows, materials } = flattenTree(trackId, root, sourceIds);
    const keep = new Set(rows.map((r) => r.id!));
    const existing = await tx.query.planNodes.findMany({
      where: eq(planNodes.trackId, trackId),
      columns: { id: true, status: true },
    });
    const existingIds = new Set(existing.map((e) => e.id));
    const stale = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
    if (stale.length > 0) await tx.delete(planNodes).where(inArray(planNodes.id, stale));
    // Detach everything first so reparenting never trips over a stale parent that is about to move.
    await tx.update(planNodes).set({ parentId: null, position: -1 }).where(eq(planNodes.trackId, trackId));
    for (const row of rows) {
      if (existingIds.has(row.id!)) {
        await tx
          .update(planNodes)
          .set({
            parentId: row.parentId,
            position: row.position,
            level: row.level,
            title: row.title,
            summary: row.summary,
            len: row.len,
            budgetHours: row.budgetHours,
            manualSplit: row.manualSplit,
          })
          .where(eq(planNodes.id, row.id!));
      } else {
        await tx.insert(planNodes).values(row);
      }
    }
    const nodeIds = rows.map((r) => r.id!);
    for (let i = 0; i < nodeIds.length; i += 500) {
      await tx.delete(nodeMaterials).where(inArray(nodeMaterials.nodeId, nodeIds.slice(i, i + 500)));
    }
    for (let i = 0; i < materials.length; i += 200) await tx.insert(nodeMaterials).values(materials.slice(i, i + 200));
  });
}

/** Plans a heading in detail (or splits a week leaf into days): inserts the children under `parentId`. */
export async function insertChildren(trackId: string, userId: string, parentId: string, children: PlanNode[], manualSplit = false): Promise<void> {
  const parent = await getOwnedNode(parentId, userId);
  if (!parent || parent.trackId !== trackId) throw new Error("Plan node not found for this user");
  await db.transaction(async (tx) => {
    const existing = await tx.query.planNodes.findMany({ where: eq(planNodes.parentId, parentId), columns: { id: true } });
    if (existing.length > 0) throw new Error("This part of the plan is already planned in detail");
    if (manualSplit) {
      const sessions = await tx.query.checkIns.findMany({ where: eq(checkIns.nodeId, parentId), columns: { id: true } });
      if (sessions.length > 0) throw new Error("This week already has sessions logged, so it can't be split into days");
      await tx.update(planNodes).set({ manualSplit: true, budgetHours: null }).where(eq(planNodes.id, parentId));
      // The week's Read table becomes the reservation its days were planned from.
      await tx
        .update(nodeMaterials)
        .set({ role: "covers", tier: null, minutes: null })
        .where(and(eq(nodeMaterials.nodeId, parentId), eq(nodeMaterials.role, "assigned")));
    }
    const rows: NewPlanNodeRow[] = children.map((child, i) => ({
      id: crypto.randomUUID(),
      trackId,
      parentId,
      position: i,
      level: child.level,
      title: child.title,
      summary: child.summary,
      len: child.len,
      status: "pending" as const,
      budgetHours: child.budgetHours,
      manualSplit: false,
    }));
    for (let i = 0; i < rows.length; i += 200) await tx.insert(planNodes).values(rows.slice(i, i + 200));
    const sourceIds = await trackSourceIds(tx, trackId);
    const refs = rows.flatMap((row, i) => refRows(row.id!, children[i], sourceIds));
    if (refs.length > 0) await tx.insert(nodeMaterials).values(refs);
  });
}

export async function getOwnedNode(nodeId: string, userId: string) {
  const node = await db.query.planNodes.findFirst({ where: eq(planNodes.id, nodeId), with: { track: true } });
  if (!node || node.track.userId !== userId) return null;
  return node;
}

export async function getLeafWithContent(nodeId: string, userId: string) {
  const node = await getOwnedNode(nodeId, userId);
  if (!node) return null;
  const [content, sessions] = await Promise.all([
    db.query.dailyContent.findFirst({ where: eq(dailyContent.nodeId, nodeId) }),
    db.query.checkIns.findMany({ where: eq(checkIns.nodeId, nodeId), orderBy: [asc(checkIns.completedAt)] }),
  ]);
  return { node, content: content ?? null, sessions };
}

export async function upsertLeafContent(
  nodeId: string,
  content: { contentMarkdown: string; citations: unknown; model: string },
): Promise<void> {
  await db
    .insert(dailyContent)
    .values({ nodeId, ...content })
    .onConflictDoUpdate({
      target: dailyContent.nodeId,
      set: {
        contentMarkdown: content.contentMarkdown,
        citations: content.citations,
        model: content.model,
        generatedAt: new Date(),
      },
    });
  await db
    .update(planNodes)
    .set({ status: "generated" })
    .where(and(eq(planNodes.id, nodeId), eq(planNodes.status, "pending")));
}

/** Completes a leaf. Day leaves get a check-in row; week leaves only flip status (their check-ins are sessions). */
export async function markLeafComplete(nodeId: string, userId: string): Promise<{ trackId: string }> {
  const node = await getOwnedNode(nodeId, userId);
  if (!node) throw new Error("Plan node not found for this user");
  if (node.status === "completed") return { trackId: node.trackId };
  await db.transaction(async (tx) => {
    if (node.level === "day") await tx.insert(checkIns).values({ nodeId });
    await tx.update(planNodes).set({ status: "completed" }).where(eq(planNodes.id, nodeId));
  });
  return { trackId: node.trackId };
}

/** Logs a study session against a week leaf. */
export async function logSession(nodeId: string, userId: string, hours: number): Promise<{ trackId: string }> {
  const node = await getOwnedNode(nodeId, userId);
  if (!node) throw new Error("Plan node not found for this user");
  await db.insert(checkIns).values({ nodeId, hours });
  return { trackId: node.trackId };
}

/** A leaf's Read table: its assigned materials in row order, each with the saved source. */
export async function getNodeReadList(nodeId: string) {
  const rows = await db
    .select({
      source: sources,
      tier: nodeMaterials.tier,
      minutes: nodeMaterials.minutes,
      note: nodeMaterials.note,
      position: nodeMaterials.position,
    })
    .from(nodeMaterials)
    .innerJoin(sources, eq(nodeMaterials.sourceId, sources.id))
    .where(and(eq(nodeMaterials.nodeId, nodeId), eq(nodeMaterials.role, "assigned")))
    .orderBy(asc(nodeMaterials.position));
  return rows;
}
