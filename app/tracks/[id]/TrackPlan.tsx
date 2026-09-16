"use client";

import { useState, useTransition } from "react";
import { PlanTree, TreeLabel, type PendingSlots } from "@/components/pensieve/PlanTree";
import { formatCostUsd } from "@/lib/formatCost";
import { childLevel, childSpans, currentLeaf, doneDays, findNode, type Granularity, type PlanNode } from "@/lib/planTree";
import { expandNodeAction } from "./actions";

interface TrackPlanProps {
  trackId: string;
  root: PlanNode;
  granularity: Granularity;
}

/** The saved plan as a tree. Expanding or splitting runs on the server and the page refreshes with the new rows. */
export function TrackPlan({ trackId, root, granularity }: TrackPlanProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    // Finished groups start folded so the current work is what you see first.
    const done = new Set<string>();
    for (const top of root.children ?? []) {
      if (top.children && doneDays(top) >= top.len) done.add(top.id);
    }
    return done;
  });
  const [openChips, setOpenChips] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<Record<string, PendingSlots>>({});
  const [error, setError] = useState<string | null>(null);
  const [lastCost, setLastCost] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();

  const current = currentLeaf(root);
  const tops = root.children ?? [];
  const label = tops[0] && tops[0].level !== "day" ? "Plan" : "Plan at a glance";

  function run(nodeId: string, reason: "expand" | "split") {
    const node = findNode(root, nodeId);
    if (!node || isPending) return;
    const below = childLevel(node.level);
    if (!below) return;
    const groups = reason === "expand" && below !== "day" && !(below === "week" && granularity === "week");
    const slots: PendingSlots = { count: childSpans(node).length, groups };
    setPending({ [nodeId]: slots });
    setError(null);
    startTransition(async () => {
      try {
        const { costUsd } = await expandNodeAction({ trackId, nodeId, reason });
        setLastCost(costUsd);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Planning failed. Try again.");
      } finally {
        setPending({});
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <TreeLabel>{label}</TreeLabel>
      <PlanTree
        root={root}
        mode="track"
        highlight={new Set()}
        lockBefore={0}
        currentLeafId={current?.id ?? null}
        pending={pending}
        collapsed={collapsed}
        openChips={openChips}
        busy={isPending}
        onToggle={(id) =>
          setCollapsed((c) => {
            const next = new Set(c);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onToggleChip={(id) =>
          setOpenChips((c) => {
            const next = new Set(c);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onExpand={(id) => run(id, "expand")}
        onSplit={(id) => run(id, "split")}
        leafHref={(node) => `/tracks/${trackId}/nodes/${node.id}`}
      />
      {lastCost !== null && <p className="text-xs text-muted-foreground">Estimated cost: {formatCostUsd(lastCost)}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
