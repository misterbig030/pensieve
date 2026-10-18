import { MAX_CHAPTERS, MAX_HEADING, MAX_SECTIONS, MIN_CHAPTERS, clip, type Chapter, type ChapterList } from "@/lib/schemas/material";

/**
 * A book's chapters. The catalogue half: Open Library's `table_of_contents` records, which are not uniform, turned
 * into a `ChapterList`, and chapter sizes as shares of the book. The page half (the finder) follows in Task 5.
 */

// ---------------------------------------------------------------------------------------------------------------
// Open Library records

/** One entry as Open Library stores it: an object in one of several shapes, or a plain string. */
export type OpenLibraryTocEntry = string | { level?: number; label?: string; title?: string; pagenum?: string | number; type?: unknown };

/** Front and back matter: never a chapter, but the first one after the last chapter bounds it. */
export const MATTER_RE = /^(preface|foreword|acknowledg|about the|index|glossary|bibliography|references|notes|epilogue|afterword|appendix|colophon|contents|dedication|copyright)/i;
/** Section headings that say nothing about the chapter's subject. */
export const SECTION_SKIP_RE = /^(summary|exercises?|conclusions?|further reading|key takeaways|review questions)$/i;
/** Positions count as print pages when the end position is within this factor of the edition's page count. */
export const PRINT_PAGES_SLACK = 1.1;

const PART_RE = /^part\b/i;
const CHAPTER_NUMBER_RE = /^(?:chapter\s+)?(\d{1,3})\b[\s.:–-]*/i;

interface Line {
  level: number;
  heading: string;
  pos: number | null;
}

/** A positive integer written as a number or a string (commas and spaces allowed); null for anything else. */
function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const t = value.replace(/[,\s]/g, "");
  return /^\d+$/.test(t) && Number(t) > 0 ? Number(t) : null;
}

/**
 * Shapes seen in the wild: `{ level, label, title }` with the page in `title`; `{ level, label, pagenum, title }`;
 * `{ level, pagenum, title }` with the heading in `title`; and strings, `*`-prefixed for depth, split on `|`.
 */
function toLine(entry: OpenLibraryTocEntry): Line | null {
  if (typeof entry === "string") {
    const stars = entry.match(/^\s*(\*+)/);
    const level = 1 + (stars ? stars[1].length : 0);
    const segments = entry.replace(/^\s*\*+/, "").split("|").map((s) => s.trim()).filter(Boolean);
    const heading = segments.find((s) => numeric(s) === null) ?? null;
    const numbers = segments.map(numeric).filter((n): n is number => n !== null);
    return heading ? { level, heading, pos: numbers.length > 0 ? numbers[numbers.length - 1] : null } : null;
  }
  const level = typeof entry.level === "number" && entry.level >= 1 ? Math.floor(entry.level) : 1;
  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  if (label) return { level, heading: label, pos: numeric(entry.pagenum) ?? numeric(title) };
  if (title && numeric(title) === null) return { level, heading: title, pos: numeric(entry.pagenum) };
  return null;
}

interface Draft {
  n: number | null;
  title: string;
  pos: number | null;
  sections: string[];
}

function toDraft(heading: string): Draft {
  const m = heading.match(CHAPTER_NUMBER_RE);
  const rest = m ? heading.slice(m[0].length).trim() : "";
  return { n: m ? Number(m[1]) : null, title: (m && rest) || heading, pos: null, sections: [] };
}

function increasing(values: number[]): boolean {
  return values.every((v, i) => i === 0 || v > values[i - 1]);
}

/**
 * The chapter list of one edition. Null when unusable: fewer than `MIN_CHAPTERS` chapters. Positions are kept only
 * when every chapter has one and they increase; `minutes` is null on every chapter until `withChapterSizes`.
 */
export function parseOpenLibraryToc(entries: OpenLibraryTocEntry[], edition: { url: string; numberOfPages: number | null }): ChapterList | null {
  const lines = entries.map(toLine).filter((l): l is Line => l !== null);
  // Books grouped in parts list the parts at level 1; the chapters are then the level below.
  const top = lines.filter((l) => l.level === 1 && !MATTER_RE.test(l.heading));
  const chapterLevel = top.length > 0 && top.every((l) => PART_RE.test(l.heading)) ? 2 : 1;

  const drafts: Draft[] = [];
  let current: Draft | null = null;
  let matterAfter: number | null = null;
  for (const line of lines) {
    if (line.level < chapterLevel) {
      // A part heading, or matter at the top level of a parts book.
      if (MATTER_RE.test(line.heading) && drafts.length > 0) {
        matterAfter ??= line.pos;
        current = null;
      }
      continue;
    }
    if (line.level === chapterLevel) {
      if (MATTER_RE.test(line.heading)) {
        if (drafts.length > 0) matterAfter ??= line.pos;
        current = null;
        continue;
      }
      current = { ...toDraft(line.heading), pos: line.pos };
      drafts.push(current);
      matterAfter = null;
      continue;
    }
    if (line.level === chapterLevel + 1 && current && !SECTION_SKIP_RE.test(line.heading)) current.sections.push(line.heading);
  }
  if (drafts.length < MIN_CHAPTERS) return null;

  const kept = drafts.slice(0, MAX_CHAPTERS);
  const positions = kept.map((d) => d.pos);
  const hasPositions = positions.every((p): p is number => p !== null) && increasing(positions as number[]);
  const last = hasPositions ? (positions[positions.length - 1] as number) : null;
  let end: number | null = null;
  if (last !== null) {
    const next = drafts.length > MAX_CHAPTERS ? drafts[MAX_CHAPTERS].pos : matterAfter;
    if (next !== null && next > last) end = next;
    else if (edition.numberOfPages !== null && edition.numberOfPages > last) end = edition.numberOfPages;
  }
  const printPages = last !== null && edition.numberOfPages !== null && (end ?? last) <= PRINT_PAGES_SLACK * edition.numberOfPages;

  const chapters: Chapter[] = kept.map((d) => ({
    n: d.n,
    title: clip(d.title, MAX_HEADING)!,
    page: hasPositions ? d.pos : null,
    minutes: null,
    sections: d.sections.map((s) => clip(s, MAX_HEADING)).filter((s): s is string => s !== null).slice(0, MAX_SECTIONS),
  }));
  return { source: "catalogue", url: edition.url, printPages, end, chapters };
}

// ---------------------------------------------------------------------------------------------------------------
// Sizes

/**
 * Each chapter's share of the whole span, applied to the book's own size. Positions are e-book positions as often
 * as print pages, so only their proportions are trusted. A last chapter nothing bounds takes the mean span of the
 * others. Unchanged when the book has no size or the list no positions.
 */
export function withChapterSizes(toc: ChapterList, bookMinutes: number | null): ChapterList {
  if (bookMinutes === null || bookMinutes <= 0 || toc.chapters.length === 0) return toc;
  const pages = toc.chapters.map((c) => c.page);
  if (!pages.every((p): p is number => p !== null)) return toc;
  const spans: number[] = [];
  for (let i = 0; i + 1 < pages.length; i++) spans.push(pages[i + 1] - pages[i]);
  const last = pages[pages.length - 1];
  if (toc.end !== null && toc.end > last) spans.push(toc.end - last);
  else if (spans.length > 0) spans.push(Math.round(spans.reduce((a, b) => a + b, 0) / spans.length));
  else return toc;
  const total = spans.reduce((a, b) => a + b, 0);
  if (total <= 0) return toc;
  return { ...toc, chapters: toc.chapters.map((c, i) => ({ ...c, minutes: Math.max(1, Math.round((bookMinutes * spans[i]) / total)) })) };
}
