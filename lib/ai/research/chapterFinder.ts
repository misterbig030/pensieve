import type { LanguageModel } from "ai";
import { z } from "zod";
import { MAX_CHAPTERS, MAX_HEADING, MAX_SECTIONS, MIN_CHAPTERS, clip, hostOf, type Chapter, type ChapterList, type Material } from "@/lib/schemas/material";
import { loggedGenerateObject, type GenerationLogContext } from "../logged";
import { CANDIDATE_STEP_EFFORT, DEFAULT_RESEARCH_MODEL, type AiModelId, type ReasoningEffort } from "../models";
import { providerError } from "../providerError";
import { SECTION_SKIP_RE } from "./chapters";
import type { ResearchCounts, ResearchEvent } from "./events";
import type { SearchProvider, SourceFetcher } from "./tools";
import { canonicalUrl, mainTitle } from "./verify";

/**
 * The page half of a book's chapters: when the catalogue has no table of contents for the backbone, one search for
 * it, up to three pages read through the shared fetcher, and one structured model call that lists the chapters and
 * names the page it read them from. A list the model cannot source to a page that was read is thrown away.
 */

export const FINDER_RESULTS = 5;
export const FINDER_READS = 3;
export const FINDER_WALL_MS = 20_000;
export const FINDER_PAGE_CHARS = 8_000;

export const chaptersAnswerSchema = z.object({
  found: z.boolean().describe("True only when one of the pages shows this book's chapter list"),
  url: z.string().nullable().describe("The one page the list came from"),
  chapters: z.array(z.object({ n: z.number().nullable(), title: z.string(), sections: z.array(z.string()) })),
});
export type ChaptersAnswer = z.infer<typeof chaptersAnswerSchema>;

export function buildChaptersPrompt(book: Pick<Material, "title" | "author">, pages: { url: string; text: string }[]): string {
  const lines = [`Find the table of contents of the book "${book.title}"${book.author ? ` by ${book.author}` : ""} in the pages below.`];
  for (const page of pages) lines.push(`--- ${page.url} ---`, page.text.slice(0, FINDER_PAGE_CHARS));
  lines.push(
    `List the book's chapters as the page gives them, in order, with the headings under each chapter when the page shows them. Set "url" to the one page the list came from. If no page shows this book's chapter list, return found: false and no chapters. Do not add chapters from memory.`,
  );
  return lines.join("\n");
}

/**
 * The answer as a `ChapterList`, or null when it names no page that was read, has fewer than `MIN_CHAPTERS` chapters,
 * or numbers that do not increase. The list's `url` is the page as it was fetched.
 */
export function validateChaptersAnswer(answer: ChaptersAnswer, readUrls: string[]): ChapterList | null {
  if (!answer.found || !answer.url) return null;
  const want = canonicalUrl(answer.url);
  const source = want ? readUrls.find((u) => canonicalUrl(u) === want) : undefined;
  if (!source) return null;
  const chapters: Chapter[] = [];
  for (const c of answer.chapters) {
    const title = clip(c.title, MAX_HEADING);
    if (!title) continue;
    const n = typeof c.n === "number" && Number.isInteger(c.n) && c.n > 0 ? c.n : null;
    const sections = c.sections
      .map((s) => clip(s, MAX_HEADING))
      .filter((s): s is string => s !== null && !SECTION_SKIP_RE.test(s))
      .slice(0, MAX_SECTIONS);
    chapters.push({ n, title, page: null, minutes: null, sections });
  }
  const kept = chapters.slice(0, MAX_CHAPTERS);
  if (kept.length < MIN_CHAPTERS) return null;
  const numbers = kept.map((c) => c.n).filter((n): n is number => n !== null);
  if (!numbers.every((n, i) => i === 0 || n > numbers[i - 1])) return null;
  return { source: "page", url: source, printPages: false, end: null, chapters: kept };
}

export interface ChapterFinderContext {
  fetcher: SourceFetcher;
  emit: (event: ResearchEvent) => void;
  signal?: AbortSignal;
  log?: GenerationLogContext;
}

export interface ChapterFinderResult {
  toc: ChapterList | null;
  counts: ResearchCounts;
  costUsd: number;
}

export interface ChapterFinder {
  find(book: Material, ctx: ChapterFinderContext): Promise<ChapterFinderResult>;
}

export interface ChapterFinderOptions {
  provider: SearchProvider;
  /** The research model; the app's default when omitted. */
  model?: AiModelId | LanguageModel;
  /** `CANDIDATE_STEP_EFFORT` when omitted: this is extraction, not judgement. */
  effort?: ReasoningEffort;
}

/**
 * Search → read → extract, under a wall clock of its own and outside the arm's budget. Nothing here throws except a
 * provider refusal on the user's own key, which the request must stop on.
 */
export function createChapterFinder(options: ChapterFinderOptions): ChapterFinder {
  const modelId = (typeof options.model === "string" ? options.model : DEFAULT_RESEARCH_MODEL) as AiModelId;
  const languageModel = options.model === undefined || typeof options.model === "string" ? undefined : options.model;
  return {
    async find(book, ctx) {
      const counts: ResearchCounts = { searches: 0, fetches: 0 };
      const timeout = AbortSignal.timeout(FINDER_WALL_MS);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      const none = (costUsd = 0): ChapterFinderResult => ({ toc: null, counts, costUsd });

      const query = `${mainTitle(book.title)} ${book.author ?? ""} table of contents`.replace(/\s+/g, " ").trim();
      counts.searches += 1;
      let results;
      try {
        results = await options.provider.search(query, { signal, maxResults: FINDER_RESULTS });
      } catch {
        return none();
      }
      ctx.emit({ type: "research.search", query, results: results.length });

      const pages: { url: string; text: string }[] = [];
      for (const result of results) {
        if (pages.length >= FINDER_READS || signal.aborted) break;
        const url = result.url.trim();
        if (!url.toLowerCase().startsWith("https://") || hostOf(url) === "openlibrary.org") continue;
        ctx.emit({ type: "research.reading", url });
        counts.fetches += 1;
        const outcome = await ctx.fetcher.fetch(url, signal);
        ctx.emit({ type: "research.fetch", url, ok: outcome.ok, ...(outcome.ok ? {} : { reason: outcome.reason }) });
        if (outcome.ok) pages.push({ url, text: outcome.page.text });
      }
      if (pages.length === 0) return none();

      const prompt = buildChaptersPrompt(book, pages);
      const readUrls = pages.map((p) => p.url);
      let costUsd = 0;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const { object, costUsd: cost } = await loggedGenerateObject(
            {
              model: modelId,
              languageModel,
              schema: chaptersAnswerSchema,
              prompt,
              label: attempt === 1 ? "Research · chapters" : "Research · chapters (retry)",
              abortSignal: signal,
              facts: readUrls,
              effort: options.effort ?? CANDIDATE_STEP_EFFORT,
            },
            { ...ctx.log, caller: "research" },
          );
          costUsd += cost;
          return { toc: validateChaptersAnswer(object, readUrls), counts, costUsd };
        } catch (error) {
          if (signal.aborted) break;
          // On the user's own key a provider refusal is theirs to hear about; a retry on the same key would be refused too.
          if (ctx.log?.keyOwner === "user" && providerError(error)) throw error;
          console.error(`[research] chapters step failed (attempt ${attempt})`, error);
        }
      }
      return none(costUsd);
    },
  };
}
