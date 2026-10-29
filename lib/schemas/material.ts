import { z } from "zod";
import { PRACTICE_FORMATS } from "@/lib/practice";
import { SOURCE_TYPES } from "./source";

export const MATERIAL_ORIGINS = ["learner", "research"] as const;
export type MaterialOrigin = (typeof MATERIAL_ORIGINS)[number];

export const MATERIAL_KINDS = ["book", "course", "video", "docs", "essay", "paper", "repo", "tool", "note"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const MATERIAL_TIERS = ["must", "should"] as const;
export type MaterialTier = (typeof MATERIAL_TIERS)[number];
/** What a unit does with a resource: reads it, or revisits one an earlier unit read. */
export const REF_ACTIVITIES = ["read", "review"] as const;
export type RefActivity = (typeof REF_ACTIVITIES)[number];

/** The directions a source can be found by: a research worker's, the learner's own, or arm A's single loop. */
export const FOUND_BY = ["backbone", "canonical", "current", "practice", "learner", "research"] as const;
export type FoundBy = (typeof FOUND_BY)[number];

/** Where a material's size came from: counted by code (pages, runtime, page length) or estimated by the model. */
export const MINUTES_BASES = ["measured", "estimated"] as const;
export type MinutesBasis = (typeof MINUTES_BASES)[number];

/** Where a book's chapter list came from: the Open Library catalogue, or a web page the research model read. */
export const CHAPTER_SOURCES = ["catalogue", "page"] as const;
export type ChapterSource = (typeof CHAPTER_SOURCES)[number];

/** Caps on a chapter list: fewer than MIN_CHAPTERS is unusable; the rest bound what the prompts carry. */
export const MIN_CHAPTERS = 3;
export const MAX_CHAPTERS = 40;
export const MAX_SECTIONS = 12;
export const MAX_HEADING = 120;

/** One chapter as a table of contents lists it. `n` is null when the heading carries no number. */
export const chapterSchema = z.object({
  n: z.number().int().min(1).nullable(),
  title: z.string().trim().min(1).max(MAX_HEADING),
  /** Start position as the list gives it: a print page only when the list's `printPages` is true. Null without positions. */
  page: z.number().int().min(0).nullable(),
  /** This chapter's share of the whole span, applied to the book's size. Null without positions or a book size. */
  minutes: z.number().int().min(1).max(60000).nullable(),
  /** Headings one level below the chapter, in order. */
  sections: z.array(z.string().trim().min(1).max(MAX_HEADING)).max(MAX_SECTIONS),
  /**
   * Where this chapter's span ends (the start of the chapter after it in the whole book), set when the list was cut
   * right after it; null when that start is unknown. Absent on uncut lists: the span ends at the next listed chapter.
   */
  end: z.number().int().min(0).nullable().optional(),
  /** Where this unit is, when it is not the list's own `url` (a chapter or section that has a page of its own). */
  url: z.string().trim().min(1).max(2000).nullable().optional(),
  /** The part, module or section of the work this unit sits under, as the work names it. */
  group: z.string().trim().min(1).max(MAX_HEADING).nullable().optional(),
});
export type Chapter = z.infer<typeof chapterSchema>;

/** A book's chapters, where they came from, and how its positions read. */
export const chapterListSchema = z.object({
  source: z.enum(CHAPTER_SOURCES),
  /** The edition on Open Library, or the page the model read the list from. */
  url: z.string().trim().min(1).max(2000),
  /** True when the positions fit the edition's page count, so they can be shown as `pp.` ranges. */
  printPages: z.boolean(),
  /** The position after the last chapter (first back-matter entry or the page count); null when unknown or without positions. */
  end: z.number().int().min(0).nullable(),
  chapters: z.array(chapterSchema).min(MIN_CHAPTERS).max(MAX_CHAPTERS),
});
export type ChapterList = z.infer<typeof chapterListSchema>;

/** How materials are grouped in the list, backbone aside. */
export const KIND_ORDER: MaterialKind[] = ["book", "course", "video", "docs", "essay", "paper", "repo", "tool", "note"];

export const KIND_LABEL: Record<MaterialKind, string> = {
  book: "Books",
  course: "Courses",
  video: "Videos",
  docs: "Docs",
  essay: "Essays",
  paper: "Papers",
  repo: "Repos",
  tool: "Tooling",
  note: "Notes",
};

/** Caps on a practice source's item list: fewer than MIN_PRACTICE_ITEMS is unusable; the rest bound what the prompts carry. */
export const MIN_PRACTICE_ITEMS = 3;
export const MAX_PRACTICE_ITEMS = 500;

/** Where a practice source's item list came from: a page that lists the items, or a machine-readable file. */
export const PRACTICE_LIST_SOURCES = ["page", "file"] as const;
export type PracticeListSource = (typeof PRACTICE_LIST_SOURCES)[number];

export const PRACTICE_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type PracticeDifficulty = (typeof PRACTICE_DIFFICULTIES)[number];

/** One problem, question or step as its source lists it. Its position in the list (1-based) is its identity. */
export const practiceItemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  /** The item's own label on its site ("49"); null when it has none. */
  number: z.string().trim().min(1).max(20).nullable(),
  /** The list's own topic name for it; null when the list is not grouped. */
  group: z.string().trim().min(1).max(120).nullable(),
  difficulty: z.enum(PRACTICE_DIFFICULTIES).nullable(),
  url: z.string().trim().min(1).max(2000).nullable(),
  solutionUrl: z.string().trim().min(1).max(2000).nullable(),
  /** Minutes of doing, when the list gives them. */
  minutes: z.number().int().min(1).max(600).nullable(),
});
export type PracticeItem = z.infer<typeof practiceItemSchema>;

/** A practice source's items in the source's own order, where they came from, and the page or file they were read from. */
export const practiceListSchema = z.object({
  items: z.array(practiceItemSchema).min(MIN_PRACTICE_ITEMS).max(MAX_PRACTICE_ITEMS),
  source: z.enum(PRACTICE_LIST_SOURCES),
  url: z.string().trim().min(1).max(2000),
});
export type PracticeList = z.infer<typeof practiceListSchema>;

/**
 * A material's role as practice: problems to solve, questions to answer, a lab to follow. `minutes` is doing time,
 * not reading time; `Material.minutes` stays the reading time and is null for a source that is practice only.
 */
export const materialPracticeSchema = z.object({
  format: z.enum(PRACTICE_FORMATS),
  /** Problems, questions or steps the source holds; null when it is not counted. */
  items: z.number().int().min(1).max(5000).nullable(),
  /** The whole count when `items` was cut to the part the plan uses (75 of 150); absent or null when it was not cut. */
  totalItems: z.number().int().min(1).max(5000).nullable().optional(),
  perItemMinutes: z.number().int().min(1).max(600).nullable(),
  minutes: z.number().int().min(1).max(60000).nullable(),
  /** Whether the source carries answers, solutions or a rubric to check against. */
  answers: z.boolean(),
  /** The source's items, when research found them. Absent on materials saved before item lists existed. */
  list: practiceListSchema.nullable().optional(),
});
export type MaterialPractice = z.infer<typeof materialPracticeSchema>;

/**
 * One material as the browser holds it. `id` is a short id (`M1`…`Mn`) while drafting and the source row's uuid once
 * the plan is saved; node references use the same id space. A researched material carries `sig`, an HMAC over its
 * url, fetched title and verification time, so a forged "verified" badge cannot be saved.
 */
export const materialSchema = z.object({
  id: z.string().min(1).max(64),
  origin: z.enum(MATERIAL_ORIGINS),
  type: z.enum(SOURCE_TYPES),
  kind: z.enum(MATERIAL_KINDS),
  url: z.string().trim().min(1).max(2000),
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().max(200).nullable(),
  year: z.number().int().min(1000).max(2200).nullable(),
  why: z.string().trim().max(400).nullable(),
  backbone: z.boolean(),
  verifiedAt: z.string().max(40).nullable(),
  fetchedTitle: z.string().max(300).nullable(),
  recommendedBy: z.array(z.string().max(2000)).max(20),
  sig: z.string().max(200).nullable(),
  /** Minutes to read or watch the part the plan uses. Optional: materials saved before sizing have none. */
  minutes: z.number().int().min(1).max(60000).nullable().optional(),
  minutesBasis: z.enum(MINUTES_BASES).nullable().optional(),
  /** The part the plan uses when that is not the whole work. */
  uses: z.string().trim().max(120).nullable().optional(),
  /** The book's chapter list, when research found one. Absent on materials saved before chapters existed. */
  toc: chapterListSchema.nullable().optional(),
  /** Set when the source also serves as practice. Absent on materials saved before practice formats existed. */
  practice: materialPracticeSchema.nullable().optional(),
  /**
   * Research's notes for the allocation while drafting, never stored (no column): `catalogued` when Open Library
   * matched the book, so it may be the backbone; `foundBy`, the directions whose notes carried it.
   */
  catalogued: z.boolean().optional(),
  foundBy: z.array(z.enum(FOUND_BY)).max(FOUND_BY.length).optional(),
  /**
   * Draft-only, never stored (no column), like `catalogued`: the minutes the material's own page measures
   * (its runtime, or its words at reading speed), whatever the material's `minutes` came to; null when it measures none.
   */
  pageMinutes: z.number().int().min(1).max(60000).nullable().optional(),
  /** Draft-only, never stored: true when the material's own page mostly links to the rest of its site, so its length is not the work's. */
  hub: z.boolean().optional(),
  /** Draft-only, never stored: a note on the material for the allocation, such as how its units were found. */
  note: z.string().max(300).nullable().optional(),
});
export type Material = z.infer<typeof materialSchema>;
/** Up to 50 of the learner's own plus what research adds (at most 25 are asked for). */
export const materialListSchema = z.array(materialSchema).max(100);

/** A leaf's assignment: a row in its Read table. */
export const materialRefSchema = z.object({
  id: z.string().min(1).max(64),
  tier: z.enum(MATERIAL_TIERS),
  minutes: z.number().int().min(0).max(6000).nullable(),
  note: z.string().max(300).nullable(),
  /** 1-based position in the material's chapter list; null or absent for the whole resource. */
  chapter: z.number().int().min(1).max(MAX_CHAPTERS).nullable().optional(),
  /** "read" when absent. */
  activity: z.enum(REF_ACTIVITIES).optional(),
});
export type MaterialRef = z.infer<typeof materialRefSchema>;

/**
 * A heading's reservation: material the units inside it will read, with no tier or minutes yet. A week split by hand
 * keeps its Read table's tier and minutes here, so the week still shows the list it was planned with.
 */
export const coverRefSchema = z.object({
  id: z.string().min(1).max(64),
  note: z.string().max(300).nullable(),
  chapter: z.number().int().min(1).max(MAX_CHAPTERS).nullable().optional(),
  activity: z.enum(REF_ACTIVITIES).optional(),
  tier: z.enum(MATERIAL_TIERS).optional(),
  minutes: z.number().int().min(0).max(6000).nullable().optional(),
});
export type CoverRef = z.infer<typeof coverRefSchema>;

/**
 * A leaf's practice row: a task of one format with how to know it is done. `id` is a material id (a practice source, or
 * the unit's reading for generated recall) or null.
 */
export const practiceRefSchema = z.object({
  format: z.enum(PRACTICE_FORMATS),
  id: z.string().min(1).max(64).nullable(),
  task: z.string().trim().min(1).max(300),
  done: z.string().trim().min(1).max(300),
  minutes: z.number().int().min(1).max(600),
  generated: z.boolean(),
  /** 1-based position in the source's item list; a row holds one item, so the two are equal. Null or absent without a list. */
  itemFrom: z.number().int().min(1).max(MAX_PRACTICE_ITEMS).nullable().optional(),
  itemTo: z.number().int().min(1).max(MAX_PRACTICE_ITEMS).nullable().optional(),
});
export type PracticeRef = z.infer<typeof practiceRefSchema>;

/**
 * A heading's reservation of a practice source for the units inside it. A week split by hand keeps its row's `task` and
 * `minutes` here, as a split week keeps its Read table; a generated row has no source, so its `id` is null.
 */
export const practiceCoverSchema = z.object({
  format: z.enum(PRACTICE_FORMATS),
  id: z.string().min(1).max(64).nullable(),
  note: z.string().max(300).nullable(),
  task: z.string().max(300).optional(),
  minutes: z.number().int().min(1).max(600).optional(),
  /** The run of items (inclusive, 1-based) the units inside take from the source's list. Null or absent without a list. */
  itemFrom: z.number().int().min(1).max(MAX_PRACTICE_ITEMS).nullable().optional(),
  itemTo: z.number().int().min(1).max(MAX_PRACTICE_ITEMS).nullable().optional(),
});
export type PracticeCover = z.infer<typeof practiceCoverSchema>;

/**
 * What the model writes for references. Looser than the wire schemas on purpose: a note that runs long or minutes
 * given as 42.5 must not fail the whole level, so bounds are applied in code (`normalizeRefs`). The model writes no
 * `activity`: a plan's reviews are the learner's choice, not the planner's, so every row it writes is a reading.
 */
export const materialRefDraftSchema = z.object({
  id: z.string().min(1).describe("A resource id from the list, e.g. M3 or M1.3"),
  tier: z.enum(MATERIAL_TIERS),
  minutes: z.number().describe("Minutes of reading or watching for this unit"),
  note: z.string().optional().describe('The part: for a chapter, the sections this unit covers ("Post-Training; Sampling"); otherwise the part ("§2 only", "lectures 3–4")'),
});
export const coverRefDraftSchema = z.object({
  id: z.string().min(1).describe("A resource id from the list, e.g. M3 or M1.3"),
  note: z.string().optional().describe('The part, only for a resource without units ("lectures 3–4"); leave it out otherwise.'),
});
export type MaterialRefDraft = z.infer<typeof materialRefDraftSchema>;
export type CoverRefDraft = z.infer<typeof coverRefDraftSchema>;

/** What the model writes for a leaf's practice row. Code decides `generated`: a row with no source is one the model wrote. */
export const practiceRefDraftSchema = z.object({
  format: z.string().describe(`One of the plan's picked formats: ${PRACTICE_FORMATS.join(", ")}`),
  id: z.string().nullable().optional().describe("The practice source's id (or one of its items, e.g. M4.12), or the unit's reading for recall written from it; left out for a row you write"),
  task: z.string().describe('Exactly what to do and which part ("NeetCode 150 · Arrays & Hashing, problems 1–6")'),
  done: z.string().describe("How the learner knows it is finished"),
  minutes: z.number().describe("Minutes of doing"),
});
/** What the model writes for a heading's reservation of a practice source. */
export const practiceCoverDraftSchema = z.object({
  format: z.string().describe("The picked format this source serves"),
  id: z.string().describe("A practice source's id from the list"),
  note: z.string().optional().describe('The part this unit takes ("Arrays & Hashing; Two Pointers")'),
  from: z.number().optional().describe("For a source with an item list, only where the rules ask for a run: the first item this unit takes, by position"),
  to: z.number().optional().describe("For a source with an item list, only where the rules ask for a run: the last item this unit takes, by position"),
});
export type PracticeRefDraft = z.infer<typeof practiceRefDraftSchema>;
export type PracticeCoverDraft = z.infer<typeof practiceCoverDraftSchema>;

export function clip(text: string | null | undefined, max: number): string | null {
  const t = text?.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The chapter a reference points at: `chapter` is its 1-based position in the list. Null for a whole resource or past the list. */
export function chapterAt(toc: ChapterList | null | undefined, chapter: number | null | undefined): Chapter | null {
  if (!toc || !chapter || chapter < 1) return null;
  return toc.chapters[chapter - 1] ?? null;
}

/** Bounds and rounds what the model wrote. Unknown ids are left for the caller to drop and report. */
export function normalizeMaterialRef(ref: MaterialRefDraft): MaterialRef {
  return {
    id: ref.id.trim(),
    tier: ref.tier,
    minutes: Number.isFinite(ref.minutes) ? Math.max(0, Math.min(6000, Math.round(ref.minutes))) : null,
    note: clip(ref.note, 300),
    activity: "read",
  };
}

export function normalizeCoverRef(ref: CoverRefDraft): CoverRef {
  return { id: ref.id.trim(), note: clip(ref.note, 300), activity: "read" };
}

/** `M1`, `M2`, … in list order. */
export function shortId(index: number): string {
  return `M${index + 1}`;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
