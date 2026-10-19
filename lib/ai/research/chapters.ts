import { MAX_CHAPTERS, MAX_HEADING, MAX_SECTIONS, MIN_CHAPTERS, clip, type Chapter, type ChapterList } from "@/lib/schemas/material";

/**
 * A book's chapters, the catalogue half: Open Library's `table_of_contents` records, which are not uniform, turned
 * into a `ChapterList`, and chapter sizes as shares of the book. The page half is `chapterFinder.ts`.
 */

// ---------------------------------------------------------------------------------------------------------------
// Open Library records

/** One entry as Open Library stores it: an object in one of several shapes, or a plain string. */
export type OpenLibraryTocEntry = string | { level?: number; label?: string; title?: string; pagenum?: string | number; type?: unknown };

/** Front and back matter: never a chapter, but the first one after the last chapter bounds it. */
export const MATTER_RE = /^(preface|foreword|acknowledg|about the|index|glossary|bibliography|references|notes|epilogue|afterword|appendi|colophon|contents|dedication|copyright|list of )/i;
/** Section headings that say nothing about the chapter's subject. */
export const SECTION_SKIP_RE = /^(summary|exercises?|conclusions?|further reading|key takeaways|review questions|bibliography|references|notes)$/i;
/** Positions count as print pages when the end position is within this factor of the edition's page count. */
export const PRINT_PAGES_SLACK = 1.1;

const PART_RE = /^part\b/i;
/** A label that only numbers its entry: "1", "Chapter 12". */
const NUMBER_TAG_RE = /^(?:chapter\s+)?(\d{1,3})$/i;
/** A label that numbers a section: "1.1", "2.3.4". */
const DOTTED_TAG_RE = /^\d{1,3}(?:\.\d{1,3})+$/;
/** A label that numbers a part: "I", "Part IV". */
const ROMAN_TAG_RE = /^(?:part\s+)?[IVXLC]{1,6}$/i;
/** A heading that carries its own chapter number: "5. Prompt Engineering", "Chapter 5: …", "第5章 …". */
const CHAPTER_NUMBER_RE = /^(?:chapter\s+)?(\d{1,3})(?!\.\d)\b[\s.:–-]*/i;
const CJK_CHAPTER_RE = /^第\s*(\d{1,3})\s*章[\s:：.．]*/;
/** A heading that carries a section number: "1.1 The Elements of Programming". */
const LEADING_DOTTED_RE = /^(\d{1,3}(?:\.\d{1,3})+)\s*/;

interface Line {
  /** The record's own level (0- or 1-based, the records differ), or the depth read from a dotted number on a flat list. */
  level: number;
  heading: string;
  pos: number | null;
  /** The label when it only numbers the entry ("1", "Chapter 3", "1.2", "IV"); the heading then comes from `title`. */
  tag: string | null;
}

/** A positive integer written as a number or a string (commas and spaces allowed); null for anything else. */
function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const t = value.replace(/[,\s]/g, "");
  return /^\d+$/.test(t) && Number(t) > 0 ? Number(t) : null;
}

/**
 * Shapes seen in the wild. The common one: `{ level: 0-based, label: "1" | "Chapter 1" | "I" | "", title: heading,
 * pagenum }`. One publisher's: `{ level: 1-based, label: heading, title: page }`. Strings: `*`-prefixed for depth,
 * `label | title | page` or `heading | page`.
 */
function toLine(entry: OpenLibraryTocEntry): Line | null {
  if (typeof entry === "string") {
    const stars = entry.match(/^\s*(\*+)/);
    const level = stars ? stars[1].length : 0;
    const segments = entry.replace(/^\s*\*+/, "").split("|").map((s) => s.trim()).filter(Boolean);
    if (segments.length >= 3 && numeric(segments[1]) === null) {
      return { level, heading: segments[1], pos: numeric(segments[segments.length - 1]), tag: segments[0] };
    }
    const heading = segments.find((s) => numeric(s) === null) ?? null;
    const numbers = segments.map(numeric).filter((n): n is number => n !== null);
    return heading ? { level, heading, pos: numbers.length > 0 ? numbers[numbers.length - 1] : null, tag: null } : null;
  }
  const level = typeof entry.level === "number" && entry.level >= 0 ? Math.floor(entry.level) : 0;
  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  if (title && numeric(title) === null) return { level, heading: title, pos: numeric(entry.pagenum), tag: label || null };
  if (label) return { level, heading: label, pos: numeric(entry.pagenum) ?? numeric(title), tag: null };
  return null;
}

function isMatter(line: Line): boolean {
  return MATTER_RE.test(line.heading) || (line.tag !== null && MATTER_RE.test(line.tag));
}

function isPart(line: Line): boolean {
  return PART_RE.test(line.heading) || (line.tag !== null && (PART_RE.test(line.tag) || ROMAN_TAG_RE.test(line.tag)));
}

/** On a flat list the depth is in the numbering: "1" is a chapter, "1.1" a section, "1.1.1" deeper. */
function inferredDepth(line: Line): number {
  if (line.tag !== null && DOTTED_TAG_RE.test(line.tag)) return line.tag.split(".").length;
  if (line.tag !== null && (NUMBER_TAG_RE.test(line.tag) || ROMAN_TAG_RE.test(line.tag))) return 1;
  const dotted = line.heading.match(LEADING_DOTTED_RE);
  return dotted ? dotted[1].split(".").length : 1;
}

interface Draft {
  n: number | null;
  title: string;
  pos: number | null;
  sections: string[];
}

function toDraft(line: Line): Draft {
  const tagged = line.tag !== null ? line.tag.match(NUMBER_TAG_RE) : null;
  if (tagged) return { n: Number(tagged[1]), title: line.heading, pos: line.pos, sections: [] };
  const own = line.heading.match(CHAPTER_NUMBER_RE) ?? line.heading.match(CJK_CHAPTER_RE);
  const rest = own ? line.heading.slice(own[0].length).trim() : "";
  return { n: own ? Number(own[1]) : null, title: (own && rest) || line.heading, pos: line.pos, sections: [] };
}

function sectionTitle(line: Line): string {
  return line.heading.replace(LEADING_DOTTED_RE, "").trim() || line.heading;
}

function increasing(values: number[]): boolean {
  return values.every((v, i) => i === 0 || v > values[i - 1]);
}

/**
 * The chapter list of one edition, or null when the record does not read as one: fewer than `MIN_CHAPTERS` chapters,
 * a few numbered chapters among unnumbered entries, numbers out of order, or parts with no chapters inside. Positions
 * are kept only when every chapter has one and they increase; `minutes` is null on every chapter until
 * `withChapterSizes`.
 */
export function parseOpenLibraryToc(entries: OpenLibraryTocEntry[], edition: { url: string; numberOfPages: number | null }): ChapterList | null {
  const lines = entries.map(toLine).filter((l): l is Line => l !== null);
  if (lines.length === 0) return null;
  // Levels are relative: records start at 0 or 1, and a flat list keeps its depth in the numbering.
  if (new Set(lines.map((l) => l.level)).size === 1) for (const line of lines) line.level = inferredDepth(line);
  const content = lines.filter((l) => !isMatter(l));
  if (content.length === 0) return null;
  const minLevel = Math.min(...content.map((l) => l.level));
  const top = content.filter((l) => l.level === minLevel);
  const chapterLevel = top.every(isPart) ? minLevel + 1 : minLevel;

  // Chapter-level events in order: a draft, or a matter line (draft null) that may bound the chapter before it.
  const events: { draft: Draft | null; pos: number | null }[] = [];
  let current: Draft | null = null;
  for (const line of lines) {
    if (line.level < chapterLevel) {
      if (isMatter(line)) {
        events.push({ draft: null, pos: line.pos });
        current = null;
      }
      continue;
    }
    if (line.level === chapterLevel) {
      if (isMatter(line)) {
        events.push({ draft: null, pos: line.pos });
        current = null;
        continue;
      }
      current = toDraft(line);
      events.push({ draft: current, pos: line.pos });
      continue;
    }
    if (line.level === chapterLevel + 1 && current && !SECTION_SKIP_RE.test(line.heading)) current.sections.push(sectionTitle(line));
  }

  // A numbered list's unnumbered entries are matter or noise ("Introduction", "On the Cover", "List of Exercises").
  const drafts = events.map((e) => e.draft).filter((d): d is Draft => d !== null);
  const numbered = drafts.filter((d) => d.n !== null);
  if (numbered.length > 0 && numbered.length < MIN_CHAPTERS) return null;
  if (!increasing(numbered.map((d) => d.n as number))) return null;
  const chapters = numbered.length > 0 ? numbered : drafts;
  if (chapters.length < MIN_CHAPTERS) return null;

  const kept = chapters.slice(0, MAX_CHAPTERS);
  const positions = kept.map((d) => d.pos);
  const hasPositions = positions.every((p): p is number => p !== null) && increasing(positions as number[]);
  const last = hasPositions ? (positions[positions.length - 1] as number) : null;
  let end: number | null = null;
  if (last !== null) {
    const lastIndex = events.findIndex((e) => e.draft === kept[kept.length - 1]);
    // Whatever follows the last kept chapter bounds it: the next chapter past the cap, a dropped entry, or matter.
    const bound = events.slice(lastIndex + 1).find((e) => e.pos !== null && e.pos > last);
    if (bound && bound.pos !== null) end = bound.pos;
    else if (edition.numberOfPages !== null && edition.numberOfPages > last) end = edition.numberOfPages;
  }
  const printPages = last !== null && edition.numberOfPages !== null && (end ?? last) <= PRINT_PAGES_SLACK * edition.numberOfPages;

  const list: Chapter[] = kept.map((d) => ({
    n: d.n,
    title: clip(d.title, MAX_HEADING)!,
    page: hasPositions ? d.pos : null,
    minutes: null,
    sections: d.sections.map((s) => clip(s, MAX_HEADING)).filter((s): s is string => s !== null).slice(0, MAX_SECTIONS),
  }));
  return { source: "catalogue", url: edition.url, printPages, end, chapters: list };
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
  // A list without positions (a web page's) shares the book evenly, the rounding remainder on the last chapter.
  if (pages.every((p) => p === null)) {
    const each = Math.round(bookMinutes / toc.chapters.length);
    return { ...toc, chapters: toc.chapters.map((c, i) => ({ ...c, minutes: i === toc.chapters.length - 1 ? bookMinutes - each * (toc.chapters.length - 1) : each })) };
  }
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
