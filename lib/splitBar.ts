import { splitPercents } from "@/lib/materials";
import { capitalize } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import type { PlanSplit } from "@/lib/studyTime";

/** Shades of the practice colour, one per picked format, darkest first. */
export const PICK_SHADES = ["bg-accent-2-700", "bg-accent-2-500", "bg-accent-2-300", "bg-accent-2-200"];

/** One share of the plan's time, as the split bar and its legend show it. */
export interface SplitPart {
  /** "reading", or the practice format. */
  key: string;
  kind: "reading" | "practice";
  label: string;
  /** The legend's percent. */
  percent: number;
  /** The bar's width in percent: a pick drafted as reading widens reading. */
  width: number;
  shade: string;
  focus: string | null;
}

/**
 * How the split divides the plan's time, reading first: the parts with a share, and the labels of the picks drafted as
 * reading because no material can be assigned to them.
 */
export function splitBar(split: PlanSplit, materials: Pick<Material, "id" | "practice" | "minutes">[]): { parts: SplitPart[]; toReading: string[] } {
  const { reading, practice, picks } = splitPercents(split, materials);
  const formats = split.formats ?? [];
  const practiceShare = (share: number) => ((100 - split.readingShare) * share) / 100;
  const drafted = new Set(picks.filter((p) => p.toReading).map((p) => p.format));
  const readingWidth = split.readingShare + formats.filter((p) => drafted.has(p.format)).reduce((sum, p) => sum + practiceShare(p.share), 0);

  const parts: SplitPart[] = [{ key: "reading", kind: "reading", label: "Reading and watching", percent: reading, width: readingWidth, shade: "bg-accent-700", focus: null }];
  if (picks.length > 0) {
    picks.forEach((p, i) => {
      if (p.toReading || p.percent <= 0) return;
      parts.push({ key: p.format, kind: "practice", label: p.label, percent: p.percent, width: practiceShare(formats[i].share), shade: PICK_SHADES[i % PICK_SHADES.length], focus: p.focus });
    });
  } else if (practice > 0) {
    parts.push({ key: "practice", kind: "practice", label: capitalize(split.practice), percent: practice, width: 100 - readingWidth, shade: "bg-accent-2-700", focus: null });
  }
  return { parts, toReading: picks.filter((p) => p.toReading).map((p) => p.label) };
}
