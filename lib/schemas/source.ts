import { z } from "zod";

export const SOURCE_TYPES = ["link", "youtube", "file", "note"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface SourceInput {
  url: string;
  title?: string;
  type: SourceType;
}

export const sourceInputSchema = z.object({
  url: z.string().trim().min(1),
  title: z.string().trim().optional(),
  type: z.enum(SOURCE_TYPES),
});

/** Detects a material's type from raw user input (URL, file path, or free text). */
export function detectSourceType(text: string): SourceType {
  const trimmed = text.trim();
  const isYoutube = trimmed.includes("youtube.com") || trimmed.includes("youtu.be");
  if (isYoutube) return "youtube";
  const isLink = /^https?:\/\//i.test(trimmed) || /^www\./i.test(trimmed);
  if (isLink) return "link";
  const isFile = /\.(pdf|mp4|mov|epub|docx?|txt|md)$/i.test(trimmed);
  if (isFile) return "file";
  return "note";
}
