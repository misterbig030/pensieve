import type { LanguageModel } from "ai";
import { z } from "zod";
import type { PracticeFormat } from "@/lib/practice";
import {
  MAX_PRACTICE_ITEMS,
  MIN_PRACTICE_ITEMS,
  PRACTICE_DIFFICULTIES,
  clip,
  hostOf,
  practiceListSchema,
  type Material,
  type PracticeDifficulty,
  type PracticeItem,
  type PracticeList,
  type PracticeListSource,
} from "@/lib/schemas/material";
import { loggedGenerateObject, type GenerationLogContext } from "../logged";
import { CANDIDATE_STEP_EFFORT, DEFAULT_RESEARCH_MODEL, type AiModelId, type ReasoningEffort } from "../models";
import { providerError } from "../providerError";
import { describeEgressError, guardedFetch, type AcceptedContentType, type GuardedFetchOptions } from "./egress";
import type { ResearchCounts, ResearchEvent } from "./events";
import { decodeBody, readableText } from "./extract";
import type { SearchProvider, SearchResult, SourceFetcher } from "./tools";
import { canonicalUrl, mainTitle } from "./verify";

/**
 * A practice source's real items: two searches, the source's own page and the best result read through the shared
 * fetcher, then one structured model call that lists the items from what it read. When nothing read lists them all but
 * points to a readable copy (a data file in the source's repository, a static page), the model names it, the finder
 * reads it whole through the egress guard, and a second call lists the items from that. A list the model cannot
 * source to something that was read is thrown away; links survive only to hosts that appear in what was read.
 */

export const ITEM_FINDER_RESULTS = 5;
/** Pages read through the shared fetcher before the first call (the source's own page first). */
export const ITEM_FIRST_READS = 2;
/** Reads tried before the first call, failures included. */
const ITEM_FIRST_TRIES = 3;
/** Files or pages the model may have read in full. */
export const ITEM_FULL_READS = 2;
/** Every read tried in all, the full reads included. */
export const ITEM_FINDER_READS = 4;
/** The clock on searching and reading. */
export const ITEM_FINDER_WALL_MS = 45_000;
/**
 * The clock on each listing call, apart from the reading wall: listing 150 problems is several thousand output tokens,
 * which the reading wall would cut off. A call that runs out leaves the source worked by count.
 */
export const ITEM_ANSWER_MS = 90_000;
/** A data file is read whole up to this many bytes: a 450-entry problem file is well under it. */
export const ITEM_FILE_BYTES = 400 * 1024;
/** A page read in full is cut to this much readable text: a 500-item list fits. */
export const ITEM_FULL_PAGE_CHARS = 60_000;
/** Everything read in full, together, in one prompt. */
export const ITEM_PROMPT_CHARS = 450_000;
const ITEM_FILE_TIMEOUT_MS = 15_000;
/** What a full read accepts: pages, plain text and data files; never a PDF. */
const FULL_READ_TYPES: readonly AcceptedContentType[] = ["text/html", "text/plain", "application/json", "text/csv"];

const ITEM_NOUN: Partial<Record<PracticeFormat, string>> = { "problem-set": "problems", recall: "questions", lab: "steps" };

// ---------------------------------------------------------------------------------------------------------------
// The full read: a data file or a page, whole, through the same egress guard

export interface FullRead {
  finalUrl: string;
  text: string;
  /** True for a data or plain-text file, false for a page reduced to its readable text. */
  file: boolean;
  /** True when the body was cut at `ITEM_FILE_BYTES`. */
  truncated: boolean;
}

export type FullReader = (url: string, signal?: AbortSignal) => Promise<FullRead>;

/**
 * Reads one URL whole under the egress rules: a JSON, CSV or plain-text file up to `ITEM_FILE_BYTES`, or an HTML page
 * as its readable text up to `ITEM_FULL_PAGE_CHARS`. Only this reader widens the guard's content types; the shared
 * page fetcher keeps HTML, PDF and plain text with its usual cut.
 */
export const guardedFullReader =
  (options: Omit<GuardedFetchOptions, "signal" | "contentTypes" | "maxBytes"> = {}): FullReader =>
  async (url, signal) => {
    const res = await guardedFetch(url, { timeoutMs: ITEM_FILE_TIMEOUT_MS, ...options, signal, contentTypes: FULL_READ_TYPES, maxBytes: ITEM_FILE_BYTES });
    const text = decodeBody(res.body, res.charset);
    if (res.contentType === "text/html") return { finalUrl: res.finalUrl, text: readableText(text).slice(0, ITEM_FULL_PAGE_CHARS), file: false, truncated: res.truncated };
    return { finalUrl: res.finalUrl, text, file: true, truncated: res.truncated };
  };

// ---------------------------------------------------------------------------------------------------------------
// What the model writes, and what code keeps of it

export const itemDraftSchema = z.object({
  title: z.string().describe("The item's title as the list gives it"),
  number: z.string().nullable().describe('The item\'s own number or label on its site, as text (e.g. "49"); null when it has none'),
  group: z.string().nullable().describe("The list's own topic or section name for it; null when the list is not grouped"),
  difficulty: z.string().nullable().describe("easy, medium or hard, when the list says; null otherwise"),
  url: z.string().nullable().describe("A link to the item itself; null unless what you read gives or shows how to build it"),
  solutionUrl: z.string().nullable().describe("A link to its solution or walkthrough; null unless what you read gives or shows how to build it"),
  minutes: z.number().nullable().describe("Minutes it takes, when the list says; null otherwise"),
});
export type ItemDraft = z.infer<typeof itemDraftSchema>;

export const itemsAnswerSchema = z.object({
  found: z.boolean().describe("True only when a page or file above lists this source's items"),
  url: z.string().nullable().describe("The one page or file the list came from"),
  items: z.array(itemDraftSchema).describe("The items in the source's own order; empty when not found"),
  read: z.array(z.string()).describe("When not found: up to two https URLs to read in full that should list every item; otherwise empty"),
});
export type ItemsAnswer = z.infer<typeof itemsAnswerSchema>;

/** A link kept only when it is https and its host appears in what the finder read. */
function seenLink(link: string | null | undefined, readText: string): string | null {
  const text = link?.trim();
  if (!text || text.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = hostOf(text);
  return host && readText.includes(host.toLowerCase()) ? text : null;
}

function difficultyOf(label: string | null | undefined): PracticeDifficulty | null {
  const d = label?.trim().toLowerCase();
  return (PRACTICE_DIFFICULTIES as readonly string[]).includes(d ?? "") ? (d as PracticeDifficulty) : null;
}

function minutesOf(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const m = Math.round(n);
  return m >= 1 && m <= 600 ? m : null;
}

/**
 * The model's items as a `PracticeList`, or null when the list's address is not https or fewer than
 * `MIN_PRACTICE_ITEMS` or more than `MAX_PRACTICE_ITEMS` items remain. Blank titles are skipped, a title repeated
 * within its group is kept once (its first place), and the order is the model's: the list's own. Links survive only
 * when https and their host appears in `readText`, the text the finder read.
 */
export function validateItemList(raw: { url: string; source: PracticeListSource; items: ItemDraft[] }, readText: string): PracticeList | null {
  if (!raw.url.toLowerCase().startsWith("https://") || !canonicalUrl(raw.url)) return null;
  const seen = readText.toLowerCase();
  const keys = new Set<string>();
  const items: PracticeItem[] = [];
  for (const d of raw.items) {
    const title = clip(d.title, 300);
    if (!title) continue;
    const group = clip(d.group, 120);
    const key = `${group ?? ""}\u0000${title.toLowerCase().replace(/\s+/g, " ")}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const number = d.number?.trim();
    items.push({
      title,
      number: number && number.length <= 20 ? number : null,
      group,
      difficulty: difficultyOf(d.difficulty),
      url: seenLink(d.url, seen),
      solutionUrl: seenLink(d.solutionUrl, seen),
      minutes: minutesOf(d.minutes),
    });
    if (items.length > MAX_PRACTICE_ITEMS) return null;
  }
  if (items.length < MIN_PRACTICE_ITEMS) return null;
  const list = practiceListSchema.safeParse({ items, source: raw.source, url: raw.url.trim() });
  return list.success ? list.data : null;
}

/** The list's distinct group names, in the order they first appear. */
export function listGroups(list: Pick<PracticeList, "items">): string[] {
  return [...new Set(list.items.map((i) => i.group).filter((g): g is string => g !== null))];
}

/** More than this share between the found count and the one research claimed is worth a fact. */
const COUNT_DRIFT = 0.1;

/** What the log shows beside the call: the list's size, groups and address, and a found count far from the claimed one. */
export function itemListFacts(list: PracticeList | null, claimed: number | null | undefined): string[] {
  if (!list) return ["no item list"];
  const groups = listGroups(list).length;
  const facts = [`${list.items.length} items`, groups > 0 ? `${groups} groups` : "no groups", list.url];
  const n = list.items.length;
  if (claimed && Math.abs(n - claimed) > COUNT_DRIFT * claimed) facts.push(`found ${n} items; research said ${claimed}`);
  return facts;
}

// ---------------------------------------------------------------------------------------------------------------
// The prompt

interface Read {
  url: string;
  finalUrl: string;
  text: string;
  /** Read whole (`full`) or through the shared fetcher's cut. */
  full: boolean;
  file: boolean;
  truncated: boolean;
}

export function buildItemsPrompt(source: Material, results: SearchResult[], reads: Read[], final: boolean): string {
  const practice = source.practice;
  const noun = (practice && ITEM_NOUN[practice.format]) ?? "items";
  const said = [
    source.why ? `Research said: ${source.why}` : null,
    source.uses ? `The part it would use: ${source.uses}.` : null,
    practice?.items ? `It was said to hold about ${practice.items} ${noun}.` : null,
  ].filter(Boolean);
  const lines = [
    `Find the full list of ${noun} in the practice source "${source.title}" (${source.url}) in what was read below.`,
    ...said,
  ];
  if (results.length > 0) {
    lines.push("", "Search results:");
    for (const r of results) lines.push(`- ${r.title} <${r.url}>: ${r.snippet.slice(0, 240)}`);
  }
  for (const r of reads) {
    const how = r.full ? (r.file ? "a file, read in full" : "a page, read in full") : "a page, cut short";
    lines.push("", `--- ${r.url} --- (${how}${r.truncated ? ", cut at the size limit" : ""})`, r.text);
  }
  lines.push(
    "",
    `List the source's ${noun} in the source's own order, from the one page or file above that lists them all. Prefer a machine-readable copy of the list (a data file in the source's repository, such as JSON or CSV) or a static page that lists every item over a page that shows only part of it.`,
    `If the source is a named part of a larger list (for example "the 150" marked by a flag in a file of 450), return only the items in that part, in the file's order.`,
    `For each item give its title; its own number or label on its site, or null; the list's own group or topic name, or null; its difficulty (easy, medium or hard) when the list gives one; a link to the item and a link to its solution; and its minutes when the list gives them.`,
    `Write a link only as it appears in what you read, or built from the item's own fields (a slug, a video id) when what you read shows that link pattern with its full address. Otherwise null. Never invent a link.`,
    `Set "url" to the one page or file the list came from. Do not add items from memory.`,
  );
  if (final) lines.push(`If nothing above lists this source's ${noun}, return found: false with no items. Leave "read" empty.`);
  else
    lines.push(
      `If nothing above lists every item but it shows where a readable copy is (a data file in the source's repository, a static page that lists them all, or one of the pages above that was cut short), return found: false and name up to two https URLs in "read" to read in full. For a file in a code repository, name its raw file URL, not the page that displays it. Otherwise return found: false with "read" empty.`,
    );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// The finder

export interface ItemFinderContext {
  fetcher: SourceFetcher;
  emit: (event: ResearchEvent) => void;
  signal?: AbortSignal;
  log?: GenerationLogContext;
}

export interface ItemFinderResult {
  list: PracticeList | null;
  counts: ResearchCounts;
  costUsd: number;
}

export interface ItemFinder {
  find(source: Material, ctx: ItemFinderContext): Promise<ItemFinderResult>;
}

export interface ItemFinderOptions {
  provider: SearchProvider;
  /** The research model; the app's default when omitted. */
  model?: AiModelId | LanguageModel;
  /** `CANDIDATE_STEP_EFFORT` when omitted: this is extraction, not judgement. */
  effort?: ReasoningEffort;
  /** Reads a file or page whole; the guarded reader when omitted. Tests pass a fake. */
  read?: FullReader;
}

/**
 * Search → read → extract, and once more from a full read when the model names one, outside the arm's budget: the
 * searching and reading under `ITEM_FINDER_WALL_MS`, each listing call under `ITEM_ANSWER_MS`. Nothing here throws
 * except a provider refusal on the user's own key.
 */
export function createItemFinder(options: ItemFinderOptions): ItemFinder {
  const modelId = (typeof options.model === "string" ? options.model : DEFAULT_RESEARCH_MODEL) as AiModelId;
  const languageModel = options.model === undefined || typeof options.model === "string" ? undefined : options.model;
  const readFull = options.read ?? guardedFullReader();
  return {
    async find(source, ctx) {
      const counts: ResearchCounts = { searches: 0, fetches: 0 };
      const timeout = AbortSignal.timeout(ITEM_FINDER_WALL_MS);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      let costUsd = 0;
      const none = (): ItemFinderResult => ({ list: null, counts, costUsd });
      const noun = (source.practice && ITEM_NOUN[source.practice.format]) ?? "items";
      const claimed = source.practice?.items ?? null;

      // Two searches at once: one for the list, one for a repository or file that holds it.
      const title = mainTitle(source.title);
      const queries = [`${title} full list of ${noun}`, `${title} ${noun} list repository data file`];
      const found = await Promise.all(
        queries.map(async (query) => {
          counts.searches += 1;
          try {
            const results = await options.provider.search(query, { signal, maxResults: ITEM_FINDER_RESULTS });
            ctx.emit({ type: "research.search", query, results: results.length });
            return results;
          } catch {
            return [];
          }
        }),
      );
      // The two result lists interleaved, each address once.
      const results: SearchResult[] = [];
      const listed = new Set<string>();
      for (let i = 0; i < ITEM_FINDER_RESULTS; i++) {
        for (const list of found) {
          const r = list[i];
          const key = r ? canonicalUrl(r.url) : null;
          if (!r || !key || listed.has(key)) continue;
          listed.add(key);
          results.push(r);
        }
      }

      const reads: Read[] = [];
      const readKeys = new Set<string>();
      const firstUrls = [source.url, ...results.map((r) => r.url)].map((u) => u.trim()).filter((u) => u.toLowerCase().startsWith("https://"));
      for (const url of firstUrls) {
        if (reads.length >= ITEM_FIRST_READS || counts.fetches >= ITEM_FIRST_TRIES || signal.aborted) break;
        const key = canonicalUrl(url);
        if (!key || readKeys.has(key)) continue;
        readKeys.add(key);
        ctx.emit({ type: "research.reading", url });
        counts.fetches += 1;
        const outcome = await ctx.fetcher.fetch(url, signal);
        ctx.emit({ type: "research.fetch", url, ok: outcome.ok, ...(outcome.ok ? {} : { reason: outcome.reason }) });
        if (outcome.ok) reads.push({ url, finalUrl: outcome.page.finalUrl, text: outcome.page.text, full: false, file: false, truncated: false });
      }
      if (reads.length === 0) return none();

      /** The answer's list, resolved to a read and checked, or null. */
      const resolve = (answer: ItemsAnswer): PracticeList | null => {
        if (!answer.found || !answer.url) return null;
        const want = canonicalUrl(answer.url);
        // A full read is preferred: it is the whole file or page, and says whether it was a file.
        const read = want ? [...reads].reverse().find((r) => canonicalUrl(r.url) === want || canonicalUrl(r.finalUrl) === want) : undefined;
        if (!read) return null;
        const readText = reads.map((r) => `${r.url}\n${r.finalUrl}\n${r.text}`).join("\n");
        return validateItemList({ url: read.url, source: read.file ? "file" : "page", items: answer.items }, readText);
      };

      const ask = async (final: boolean): Promise<ItemsAnswer | null> => {
        const prompt = buildItemsPrompt(source, results, reads, final);
        const clock = AbortSignal.timeout(ITEM_ANSWER_MS);
        const callSignal = ctx.signal ? AbortSignal.any([ctx.signal, clock]) : clock;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const { object, costUsd: cost } = await loggedGenerateObject(
              {
                model: modelId,
                languageModel,
                schema: itemsAnswerSchema,
                prompt,
                label: `Research · items${final ? " (read in full)" : ""}${attempt === 1 ? "" : " (retry)"}`,
                abortSignal: callSignal,
                check: (answer) => [...itemListFacts(resolve(answer), claimed), ...(final || answer.found ? [] : answer.read.map((u) => `asks to read ${u}`))],
                effort: options.effort ?? CANDIDATE_STEP_EFFORT,
              },
              { ...ctx.log, caller: "research" },
            );
            costUsd += cost;
            return object;
          } catch (error) {
            if (callSignal.aborted) break;
            // On the user's own key a provider refusal is theirs to hear about; a retry on the same key would be refused too.
            if (ctx.log?.keyOwner === "user" && providerError(error)) throw error;
            console.error(`[research] items step failed (attempt ${attempt})`, error);
          }
        }
        return null;
      };

      const first = await ask(false);
      if (!first) return none();
      const list = resolve(first);
      if (list || first.found) return { list, counts, costUsd };

      // Nothing read listed them all, but the model named where a readable copy is: read it whole, then ask once more.
      let room = ITEM_PROMPT_CHARS;
      const before = reads.length;
      for (const raw of first.read) {
        if (counts.fetches >= ITEM_FINDER_READS || reads.length - before >= ITEM_FULL_READS || signal.aborted || room <= 0) break;
        const url = raw.trim();
        if (!url.toLowerCase().startsWith("https://") || !canonicalUrl(url)) continue;
        ctx.emit({ type: "research.reading", url });
        counts.fetches += 1;
        try {
          const got = await readFull(url, signal);
          ctx.emit({ type: "research.fetch", url, ok: true });
          const text = got.text.slice(0, room);
          room -= text.length;
          reads.push({ url, finalUrl: got.finalUrl, text, full: true, file: got.file, truncated: got.truncated || text.length < got.text.length });
        } catch (error) {
          ctx.emit({ type: "research.fetch", url, ok: false, reason: describeEgressError(error) });
        }
      }
      if (reads.length === before) return none();
      const second = await ask(true);
      return { list: second ? resolve(second) : null, counts, costUsd };
    },
  };
}
