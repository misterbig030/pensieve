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
  const lastCompletedDayIndex = existing
    .filter((item) => item.status === "completed")
    .reduce((max, item) => Math.max(max, item.dayIndex), 0);

  return draftItems.map((item, index) => ({
    ...item,
    dayIndex: lastCompletedDayIndex + 1 + index,
  }));
}
