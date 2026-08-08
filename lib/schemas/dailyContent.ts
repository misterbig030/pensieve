import { z } from "zod";

export const dailyContentSchema = z.object({
  contentMarkdown: z.string().min(1),
  citations: z.array(
    z.object({
      title: z.string().min(1),
      url: z.string().url(),
    }),
  ),
});

export type DailyContentDraft = z.infer<typeof dailyContentSchema>;
