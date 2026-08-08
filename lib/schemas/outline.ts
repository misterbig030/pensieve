import { z } from "zod";

export const outlineDraftItemSchema = z.object({
  dayIndex: z.number().int().positive(),
  title: z.string().min(1),
  summary: z.string().min(1),
});

export const outlineDraftSchema = z.object({
  items: z.array(outlineDraftItemSchema).min(1),
});

export type OutlineDraftItem = z.infer<typeof outlineDraftItemSchema>;
export type OutlineDraft = z.infer<typeof outlineDraftSchema>;
