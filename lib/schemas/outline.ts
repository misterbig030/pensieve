import { z } from "zod";

export const outlineDraftItemSchema = z.object({
  dayIndex: z.number().int().positive(),
  title: z.string().min(1),
  summary: z.string().min(1),
});

export const outlineDraftSchema = z.object({
  // Upper bound keeps curricula to a realistic length (~2 months); also
  // guards against unbounded client-supplied payloads reaching the DB.
  items: z.array(outlineDraftItemSchema).min(1).max(60),
});

export type OutlineDraftItem = z.infer<typeof outlineDraftItemSchema>;
export type OutlineDraft = z.infer<typeof outlineDraftSchema>;
