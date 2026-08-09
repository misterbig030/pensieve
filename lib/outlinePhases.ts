const PHASE_NAMES = ["Foundations", "Applied practice", "Mastery & review"];

interface PhaseItem {
  dayIndex: number;
  title: string;
  summary: string;
}

export interface Phase<T extends PhaseItem> {
  label: string;
  range: string;
  focus: string;
  days: T[];
}

/** Splits an ordered list of outline items into up to 3 roughly-equal phases. */
export function chunkIntoPhases<T extends PhaseItem>(items: T[]): T[][] {
  if (items.length === 0) return [];
  const chunkCount = Math.min(3, items.length);
  const size = Math.ceil(items.length / chunkCount);
  const chunks: T[][] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunk = items.slice(i * size, i * size + size);
    if (chunk.length > 0) chunks.push(chunk);
  }
  return chunks;
}

/** Groups an ordered list of outline items into labeled phases with a synthesized focus sentence. */
export function buildPhases<T extends PhaseItem>(items: T[]): Phase<T>[] {
  return chunkIntoPhases(items).map((chunk, i) => {
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    return {
      label: PHASE_NAMES[i] ?? `Phase ${i + 1}`,
      range: chunk.length > 1 ? `Day ${first.dayIndex}–${last.dayIndex}` : `Day ${first.dayIndex}`,
      focus:
        chunk.length > 1
          ? `${first.title} through ${last.title.toLowerCase()}.`
          : `${first.title}.`,
      days: chunk,
    };
  });
}
