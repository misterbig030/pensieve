import { z } from "zod";
import { SOURCE_TYPES } from "./source";

export const MATERIAL_ORIGINS = ["learner", "research"] as const;
export type MaterialOrigin = (typeof MATERIAL_ORIGINS)[number];

export const MATERIAL_KINDS = ["book", "course", "video", "docs", "essay", "paper", "repo", "tool", "note"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const MATERIAL_TIERS = ["must", "should"] as const;
export type MaterialTier = (typeof MATERIAL_TIERS)[number];

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
});
export type MaterialRef = z.infer<typeof materialRefSchema>;

/** A heading's reservation: material the units inside it will read, with no tier or minutes yet. */
export const coverRefSchema = z.object({
  id: z.string().min(1).max(64),
  note: z.string().max(300).nullable(),
});
export type CoverRef = z.infer<typeof coverRefSchema>;

/**
 * What the model writes for references. Looser than the wire schemas on purpose: a note that runs long or minutes
 * given as 42.5 must not fail the whole level, so bounds are applied in code (`normalizeRefs`).
 */
export const materialRefDraftSchema = z.object({
  id: z.string().min(1).describe("A material id from the list, e.g. M3"),
  tier: z.enum(MATERIAL_TIERS),
  minutes: z.number().describe("Minutes of reading or watching for this unit"),
  note: z.string().optional().describe('Which part, e.g. "Ch. 4 §2" or "evals and guardrails sections only"'),
});
export const coverRefDraftSchema = z.object({
  id: z.string().min(1).describe("A material id from the list, e.g. M1"),
  note: z.string().optional().describe('Which part this unit reserves, e.g. "ch. 5–6" or "whole essay"'),
});
export type MaterialRefDraft = z.infer<typeof materialRefDraftSchema>;
export type CoverRefDraft = z.infer<typeof coverRefDraftSchema>;

export function clip(text: string | null | undefined, max: number): string | null {
  const t = text?.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Bounds and rounds what the model wrote. Unknown ids are left for the caller to drop and report. */
export function normalizeMaterialRef(ref: MaterialRefDraft): MaterialRef {
  return {
    id: ref.id.trim(),
    tier: ref.tier,
    minutes: Number.isFinite(ref.minutes) ? Math.max(0, Math.min(6000, Math.round(ref.minutes))) : null,
    note: clip(ref.note, 300),
  };
}

export function normalizeCoverRef(ref: CoverRefDraft): CoverRef {
  return { id: ref.id.trim(), note: clip(ref.note, 300) };
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
