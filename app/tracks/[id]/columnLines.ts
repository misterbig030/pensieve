import { materialTotals } from "@/components/pensieve/MaterialsList";
import { approxDuration } from "@/lib/researchProgress";
import type { Material } from "@/lib/schemas/material";

/** "≈ 17 h of reading · 22 h of practice · 2 with no size": how much there is, leaving out a part that is zero. */
export function columnTotals(materials: Material[]): string {
  const { readingMinutes, practiceMinutes } = materialTotals(materials);
  const unsized = materials.filter((m) => !m.minutes && !m.practice?.minutes).length;
  const parts = [
    readingMinutes > 0 && `${approxDuration(readingMinutes)} of reading`,
    practiceMinutes > 0 && `${approxDuration(practiceMinutes)} of practice`,
  ].filter((p): p is string => Boolean(p));
  return [...parts.map((p, i) => (i > 0 ? p.replace("≈ ", "") : p)), unsized > 0 && `${unsized} with no size`].filter(Boolean).join(" · ");
}

/** Whose materials these are, short: "all checked", "11 checked · 2 yours" or "2 yours". */
export function checkedShort(materials: Material[]): string {
  const checked = materials.filter((m) => m.origin === "research").length;
  const yours = materials.length - checked;
  return yours === 0 ? "all checked" : checked === 0 ? `${yours} yours` : `${checked} checked · ${yours} yours`;
}
