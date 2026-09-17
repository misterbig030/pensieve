import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "./client";
import { checkIns, dailyContent, planNodes, tracks, type NewPlanNodeRow, type PlanNodeRow } from "./schema";
import { makeRoot, walk, type PlanNode } from "@/lib/planTree";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Builds the in-memory tree from a track's rows. Every stored node is present; a childless node is a leaf. */
export function rowsToTree(rows: PlanNodeRow[]): PlanNode {
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
      start: 1,
      end: row.len,
    };
  };
  const tops = (byParent.get(null) ?? []).sort((a, b) => a.position - b.position).map(build);
  return makeRoot(tops);
}

export async function getPlanTree(trackId: string): Promise<PlanNode> {
  const rows = await db.query.planNodes.findMany({
    where: eq(planNodes.trackId, trackId),
    orderBy: [asc(planNodes.position)],
  });
  return rowsToTree(rows);
}

/** Flattens a tree into insertable rows, minting uuids for temporary ids and remapping parents accordingly. */
export function treeToRows(trackId: string, root: PlanNode): NewPlanNodeRow[] {
  const rows: NewPlanNodeRow[] = [];
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
  });
  return rows;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function insertPlanTree(tx: Tx, trackId: string, root: PlanNode): Promise<void> {
  const rows = treeToRows(trackId, root);
  // Parents are always emitted before their children by `walk`, so one ordered insert satisfies the self-reference.
  for (let i = 0; i < rows.length; i += 200) {
    await tx.insert(planNodes).values(rows.slice(i, i + 200));
  }
}

/**
 * Adjust-mode confirm: nodes that still exist keep their rows (and so their content and check-ins); nodes missing
 * from the new tree are deleted; new nodes are inserted. Positions and parents are rewritten from the tree.
 */
export async function replacePlanTree(trackId: string, userId: string, root: PlanNode): Promise<void> {
  const track = await db.query.tracks.findFirst({
    where: and(eq(tracks.id, trackId), eq(tracks.userId, userId)),
    columns: { id: true },
  });
  if (!track) throw new Error("Track not found for this user");

  const rows = treeToRows(trackId, root);
  const keep = new Set(rows.map((r) => r.id!));
  await db.transaction(async (tx) => {
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
