import { z } from "zod";

/** The info string of the fenced block a lesson puts a generated recall task's answers in, as markdown; the lesson shows it collapsed. */
export const ANSWERS_FENCE = "answers";

/** The info string of a fenced block holding one step of a lesson: `task:` and `minutes:` lines, then what to do, as markdown. */
export const STEP_FENCE = "step";

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
