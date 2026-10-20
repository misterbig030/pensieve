import { z } from "zod";
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

/** A heading's reservation: material the units inside it will read, with no tier or minutes yet. */
export const coverRefSchema = z.object({
  id: z.string().min(1).max(64),
  note: z.string().max(300).nullable(),
  chapter: z.number().int().min(1).max(MAX_CHAPTERS).nullable().optional(),
  activity: z.enum(REF_ACTIVITIES).optional(),
});
export type CoverRef = z.infer<typeof coverRefSchema>;

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
  note: z.string().optional().describe('The part only for a resource without chapters ("lectures 3–4"); leave it out otherwise'),
});
export type MaterialRefDraft = z.infer<typeof materialRefDraftSchema>;
export type CoverRefDraft = z.infer<typeof coverRefDraftSchema>;

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
