interface ExistingItem {
  dayIndex: number;
  status: "pending" | "generated" | "completed";
}

interface DraftItem {
  title: string;
  summary: string;
}

export interface ReindexedItem extends DraftItem {
  dayIndex: number;
}

export function computeOutlineReplacement(
  existing: ExistingItem[],
  draftItems: DraftItem[],
): ReindexedItem[] {
  // Anchor on the highest dayIndex across ALL existing items (completed or
  // not), not just completed ones. Anchoring on completed-only assumes
  // completion always happens in contiguous order; if a user completes a
  // later day while earlier days are still pending (out-of-order
  // completion), that would cause new items to overwrite/renumber over
  // still-pending earlier days. Appending after the true max preserves any
  // out-of-order pending days untouched.
  const maxDayIndex = existing.reduce((max, item) => Math.max(max, item.dayIndex), 0);

  return draftItems.map((item, index) => ({
    ...item,
    dayIndex: maxDayIndex + 1 + index,
  }));
}
