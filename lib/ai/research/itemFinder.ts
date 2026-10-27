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
import { applyMapping, fieldMappingSchema, parseDataFile, sampleDataFile, type DataFile, type FieldMapping } from "./dataFile";
import { describeEgressError, guardedFetch, type AcceptedContentType, type GuardedFetchOptions } from "./egress";
import type { ResearchCounts, ResearchEvent } from "./events";
import { decodeBody, readableText } from "./extract";
import type { SearchProvider, SearchResult, SourceFetcher } from "./tools";
import { canonicalUrl, mainTitle } from "./verify";

/**
 * A practice source's real items. Two searches and the source's own page and the best result, read through the shared
 * fetcher; then a short call that says where the full list is: a page already read, or up to two addresses to read in
 * full (a data file in the source's repository, a static page). A data file (JSON or CSV) is never copied out by the
 * model: it sees a sample of the records and returns a field mapping, and code applies it to every record in file order.
 * A page is transcribed by the model. Either way the list must trace to something read, its titles must appear in what
 * was read, and its links survive only to hosts that appear in what was read.
 */

export const ITEM_FINDER_RESULTS = 5;
/** Pages read through the shared fetcher before the first call (the source's own page first). */
export const ITEM_FIRST_READS = 2;
/** Files or pages the model may have read in full. */
export const ITEM_FULL_READS = 2;
/** Every read tried in all, the full reads included. */
export const ITEM_FINDER_READS = 4;

/** Clocks, one per stage, so a slow stage never starves the next. */
export const ITEM_GATHER_MS = 15_000;
export const ITEM_LOCATE_MS = 10_000;
export const ITEM_FULL_READ_MS = 10_000;
export const ITEM_MAP_MS = 10_000;
/** The data-file path's worst case: searching and reading, the where call, the full reads, the mapping call. */
export const ITEM_FINDER_WALL_MS = ITEM_GATHER_MS + ITEM_LOCATE_MS + ITEM_FULL_READ_MS + ITEM_MAP_MS;
/**
 * The clock on transcribing a page, the path for lists with no data file: listing 150 problems is several thousand
 * output tokens. A call that runs out leaves the source worked by count.
 */
export const ITEM_ANSWER_MS = 90_000;
/** A data file is read whole up to this many bytes: a 450-entry problem file is well under it. */
export const ITEM_FILE_BYTES = 400 * 1024;
/** A page (or a file that is not data) read in full is cut to this much text: a 500-item list fits. */
export const ITEM_FULL_PAGE_CHARS = 60_000;
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
    const res = await guardedFetch(url, { timeoutMs: ITEM_FULL_READ_MS, ...options, signal, contentTypes: FULL_READ_TYPES, maxBytes: ITEM_FILE_BYTES });
    const text = decodeBody(res.body, res.charset);
    if (res.contentType === "text/html") {
      // A page longer than the cut is not read in full, whatever its bytes: the finder must not take part of a list for all of it.
      const readable = readableText(text);
      return { finalUrl: res.finalUrl, text: readable.slice(0, ITEM_FULL_PAGE_CHARS), file: false, truncated: res.truncated || readable.length > ITEM_FULL_PAGE_CHARS };
    }
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
  found: z.boolean().describe("True only when a page above lists this source's items"),
  url: z.string().nullable().describe("The one page the list came from"),
  items: z.array(itemDraftSchema).describe("The items in the source's own order; empty when not found"),
});
export type ItemsAnswer = z.infer<typeof itemsAnswerSchema>;

export const locateAnswerSchema = z.object({
  list: z.string().nullable().describe("A page above that shows every item, uncut; null when none does"),
  read: z.array(z.string()).describe("Up to two https URLs to read in full that should list every item; empty when none"),
});
export type LocateAnswer = z.infer<typeof locateAnswerSchema>;

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

/** A short label as a site numbers its items: "49", "Q12", "1.2", "12a". */
const NUMBER_LABEL_RE = /^[A-Za-z]{0,3}\d{1,5}(?:[.-]\d{1,3})?[A-Za-z]?$/;
/** The longest number label kept as it is. */
const MAX_NUMBER_LABEL = 8;

/**
 * An item's number as a row shows it: a short label as written ("Q12", "1.2"), digits without leading zeros ("0049" is
 * 49), or the leading number of a longer code ("0049-group-anagrams" is 49). Anything else (a slug, a title) is null.
 */
export function itemNumber(raw: string | null | undefined): string | null {
  const s = raw?.trim().replace(/^#/, "").replace(/[.)]$/, "");
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = s.replace(/^0+/, "");
    return n && n.length <= 5 ? n : null;
  }
  if (s.length <= MAX_NUMBER_LABEL && NUMBER_LABEL_RE.test(s)) return s;
  const lead = s.match(/^(\d{1,5})[\s._:-]/)?.[1].replace(/^0+/, "");
  return lead || null;
}

function minutesOf(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const m = Math.round(n);
  return m >= 1 && m <= 600 ? m : null;
}

/** Text reduced to its letters and digits, lower-cased, single-spaced: so a title matches its place in a page or file. */
export function normalText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** More than this share of titles missing from what was read and the whole list is refused: it was not read, it was made. */
export const MAX_UNSEEN_SHARE = 0.1;

/**
 * The drafted items as a `PracticeList`, or null when the list's address is not https, when more than
 * `MAX_UNSEEN_SHARE` of the titles do not appear in `readText`, or when fewer than `MIN_PRACTICE_ITEMS` or more than
 * `MAX_PRACTICE_ITEMS` items remain. Blank titles are skipped, a title repeated within its group is kept once (its first
 * place), a title not found in what was read is dropped, and the order is the drafts': the list's own. Links survive
 * only when https and their host appears in `readText`, the text the finder read.
 */
export function validateItemList(raw: { url: string; source: PracticeListSource; items: ItemDraft[] }, readText: string): PracticeList | null {
  if (!raw.url.toLowerCase().startsWith("https://") || !canonicalUrl(raw.url)) return null;
  const seen = readText.toLowerCase();
  const haystack = ` ${normalText(readText)} `;
  const keys = new Set<string>();
  const items: PracticeItem[] = [];
  let unseen = 0;
  for (const d of raw.items) {
    const title = clip(d.title, 300);
    if (!title) continue;
    const group = clip(d.group, 120);
    const key = `${group ?? ""}\u0000${title.toLowerCase().replace(/\s+/g, " ")}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const words = normalText(title.replace(/…$/, ""));
    if (!words || !haystack.includes(` ${words} `)) {
      unseen += 1;
      continue;
    }
    items.push({
      title,
      number: itemNumber(d.number),
      group,
      difficulty: difficultyOf(d.difficulty),
      url: seenLink(d.url, seen),
      solutionUrl: seenLink(d.solutionUrl, seen),
      minutes: minutesOf(d.minutes),
    });
    if (items.length > MAX_PRACTICE_ITEMS) return null;
  }
  if (unseen > MAX_UNSEEN_SHARE * (items.length + unseen)) return null;
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
// The prompts

interface Read {
  url: string;
  finalUrl: string;
  text: string;
  /** Read whole (`full`) or through the shared fetcher's cut. */
  full: boolean;
  file: boolean;
  truncated: boolean;
}

function nounOf(source: Material): string {
  return (source.practice && ITEM_NOUN[source.practice.format]) ?? "items";
}

/** The source, what research said of it, and what was read: the head of every prompt. */
function sourceLines(source: Material, results: SearchResult[], reads: Read[]): string[] {
  const practice = source.practice;
  const noun = nounOf(source);
  const lines = [
    `The practice source "${source.title}" (${source.url}) is a list of ${noun}.`,
    ...[
      source.why ? `Research said: ${source.why}` : null,
      source.uses ? `The part it would use: ${source.uses}.` : null,
      practice?.items ? `It was said to hold about ${practice.items} ${noun}.` : null,
    ].filter((l): l is string => l !== null),
  ];
  if (results.length > 0) {
    lines.push("", "Search results:");
    for (const r of results) lines.push(`- ${r.title} <${r.url}>: ${r.snippet.slice(0, 240)}`);
  }
  for (const r of reads) {
    const how = r.full ? (r.file ? "a file, read in full" : "a page, read in full") : "a page, cut short";
    lines.push("", `--- ${r.url} --- (${how}${r.truncated ? ", cut at the size limit" : ""})`, r.text);
  }
  return lines;
}

/** The first call: where is the whole list? A page already read, or addresses to read in full. */
export function buildLocatePrompt(source: Material, results: SearchResult[], reads: Read[]): string {
  const noun = nounOf(source);
  return [
    ...sourceLines(source, results, reads),
    "",
    `Say where the full list of this source's ${noun} can be read.`,
    `If one page above shows every item, set "list" to its address.`,
    `If what you read shows where a readable copy is, or a page above that lists them was cut short, name up to two https URLs in "read" to read in full. Prefer a machine-readable data file in the source's repository (JSON or CSV; for a file in a code repository, its raw file URL, not the page that displays it), then a static page that lists every item.`,
    `Name only addresses that appear above or follow directly from them (a file a repository page names). If neither, leave "list" null and "read" empty.`,
  ].join("\n");
}

/** The mapping call: the pages read (where link patterns show), and a sample of the data file's records. */
export function buildMappingPrompt(source: Material, reads: Read[], fileUrl: string, file: DataFile): string {
  const noun = nounOf(source);
  return [
    ...sourceLines(source, [], reads),
    "",
    `--- ${fileUrl} --- (a ${file.kind === "json" ? "JSON" : "CSV"} file, read in full; its records are sampled below)`,
    sampleDataFile(file),
    "",
    `Code will apply your mapping to every record of this file, in the file's order. Map the file to the source's ${noun}:`,
    `- "path": for JSON, the path of the records that are the ${noun}, exactly as listed above; null for CSV.`,
    `- "title", "number", "group", "difficulty", "minutes": the field that holds each, or null when the file has none. Write ../field for a field of the object a record sits in. For "number", a field that starts with the item's number (such as a code like 0049-group-anagrams) will do: code keeps the number.`,
    `- "url" and "solutionUrl": a link template over fields, such as https://example.com/problems/{slug} or https://example.com/watch?v={video}, only when the pages or the file above show that link pattern with its full address; "{field}" when a field holds the whole link. Otherwise null. Never invent a link.`,
    `- "subset": when the source is a named part of the file (for example "the 150" marked by a flag field in a file of 450), the field that marks it and the value that means "in" (e.g. "true"); null for the whole file.`,
    `If the file does not list this source's ${noun}, return found: false.`,
  ].join("\n");
}

/** The transcription call, for a list on a page with no data file. */
export function buildItemsPrompt(source: Material, results: SearchResult[], reads: Read[]): string {
  const noun = nounOf(source);
  return [
    ...sourceLines(source, results, reads),
    "",
    `List the source's ${noun} in the source's own order, from the one page above that lists them all.`,
    `If the source is a named part of a larger list (for example "the 150" marked in a list of 450), return only the items in that part, in the list's order.`,
    `For each item give its title as written; its own number or label on its site, or null; the list's own group or topic name, or null; its difficulty (easy, medium or hard) when the list gives one; a link to the item and a link to its solution; and its minutes when the list gives them.`,
    `Write a link only as it appears in what you read, or built from the item's own fields (a slug, a video id) when what you read shows that link pattern with its full address. Otherwise null. Never invent a link.`,
    `Set "url" to the one page the list came from. Do not add items from memory. If no page above lists this source's ${noun}, return found: false with no items.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the item list at an address

export interface ItemReadContext {
  fetcher: SourceFetcher;
  emit: (event: ResearchEvent) => void;
  signal?: AbortSignal;
  log?: GenerationLogContext;
}

export interface ItemReadOptions {
  /** The research model; the app's default when omitted. */
  model?: AiModelId | LanguageModel;
  /** `CANDIDATE_STEP_EFFORT` when omitted: this is extraction, not judgement. */
  effort?: ReasoningEffort;
  /** Reads a file or page whole; the guarded reader when omitted. Tests pass a fake. */
  read?: FullReader;
  /**
   * Pages the caller has already read. They sit in the prompts as context (where link patterns show), and a `url`
   * that is one of them is taken from here, not read again.
   */
  pages?: { url: string; finalUrl: string; text: string }[];
}

export interface ItemReadResult {
  list: PracticeList | null;
  counts: ResearchCounts;
  costUsd: number;
}

/** Every read's address and the text it gave: what a title or a link's host must appear in. */
function textOf(reads: Read[]): string {
  return reads.map((r) => `${r.url}\n${r.finalUrl}\n${r.text}`).join("\n");
}

/**
 * A model call with one retry, on a clock of `ms` milliseconds. Null when both attempts fail or the clock runs out; a
 * provider refusal on the user's own key is thrown, since a retry on the same key would be refused too.
 */
function modelAsker(
  model: { modelId: AiModelId; languageModel: LanguageModel | undefined; effort: ReasoningEffort | undefined },
  ctx: { signal?: AbortSignal; log?: GenerationLogContext },
  addCost: (costUsd: number) => void,
) {
  return async <T,>(schema: z.ZodType<T>, prompt: string, label: string, ms: number, check: (answer: T) => string[]): Promise<T | null> => {
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { object, costUsd } = await loggedGenerateObject(
          {
            model: model.modelId,
            languageModel: model.languageModel,
            schema,
            prompt,
            label: attempt === 1 ? label : `${label} (retry)`,
            abortSignal: signal,
            check,
            effort: model.effort ?? CANDIDATE_STEP_EFFORT,
          },
          { ...ctx.log, caller: "research" },
        );
        addCost(costUsd);
        return object;
      } catch (error) {
        if (signal.aborted) break;
        if (ctx.log?.keyOwner === "user" && providerError(error)) throw error;
        console.error(`[research] ${label} failed (attempt ${attempt})`, error);
      }
    }
    return null;
  };
}

/**
 * Reads `url` in full (a page already given in `options.pages` is not read again), then: a data file goes to the
 * mapping call, code applies the mapping to every record; a page goes to the transcription call. Each model call is on
 * its own clock (`ITEM_MAP_MS`, `ITEM_ANSWER_MS`), the read on `ITEM_FULL_READ_MS`, so a slow stage never starves the
 * next. A data file that cannot be mapped is not transcribed: the source is left to count. Nothing here throws except a
 * provider refusal on the user's own key.
 */
export async function readItemListAt(source: Material, url: string, ctx: ItemReadContext, options: ItemReadOptions = {}): Promise<ItemReadResult> {
  const modelId = (typeof options.model === "string" ? options.model : DEFAULT_RESEARCH_MODEL) as AiModelId;
  const languageModel = options.model === undefined || typeof options.model === "string" ? undefined : options.model;
  const readFull = options.read ?? guardedFullReader();
  const counts: ResearchCounts = { searches: 0, fetches: 0 };
  let costUsd = 0;
  const none = (): ItemReadResult => ({ list: null, counts, costUsd });
  const clock = (ms: number) => (ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
  const claimed = source.practice?.items ?? null;

  const ask = modelAsker({ modelId, languageModel, effort: options.effort }, ctx, (cost) => (costUsd += cost));

  const context: Read[] = (options.pages ?? []).map((p) => ({ ...p, full: false, file: false, truncated: false }));
  const want = canonicalUrl(url);
  if (!url.trim().toLowerCase().startsWith("https://") || !want) return none();
  const target = url.trim();

  // 1. The address, read in full (or taken from the pages already read).
  const given = context.find((r) => canonicalUrl(r.url) === want || canonicalUrl(r.finalUrl) === want);
  let full: Read | undefined = given;
  if (!full) {
    ctx.emit({ type: "research.reading", url: target });
    counts.fetches += 1;
    try {
      const got = await readFull(target, clock(ITEM_FULL_READ_MS));
      ctx.emit({ type: "research.fetch", url: target, ok: true });
      full = { url: target, finalUrl: got.finalUrl, text: got.text, full: true, file: got.file, truncated: got.truncated };
    } catch (error) {
      ctx.emit({ type: "research.fetch", url: target, ok: false, reason: describeEgressError(error) });
      return none();
    }
  }
  const reads = context.filter((r) => r !== given);

  // 2. A data file: the model maps its fields from a sample, code reads every record.
  const data = full.file && !given ? parseDataFile(full.text, full.truncated) : null;
  if (data) {
    const readText = textOf([...reads, full]);
    const fromMapping = (mapping: FieldMapping): PracticeList | null => {
      const drafts = applyMapping(data, mapping);
      return drafts ? validateItemList({ url: full.url, source: "file", items: drafts }, readText) : null;
    };
    const mapping = await ask(fieldMappingSchema, buildMappingPrompt(source, reads, full.url, data), "Research · items · mapping", ITEM_MAP_MS, (m) =>
      itemListFacts(fromMapping(m), claimed),
    );
    return { list: mapping ? fromMapping(mapping) : null, counts, costUsd };
  }

  // 3. Otherwise a page that lists them, transcribed.
  const page: Read = full.file ? full : { ...full, text: full.text.slice(0, ITEM_FULL_PAGE_CHARS), truncated: full.truncated || full.text.length > ITEM_FULL_PAGE_CHARS };
  const pages: Read[] = [...reads, page];
  const resolve = (answer: ItemsAnswer): PracticeList | null => {
    if (!answer.found || !answer.url) return null;
    const asked = canonicalUrl(answer.url);
    // Only a page that was read can be the list's page.
    const read = asked ? pages.find((r) => canonicalUrl(r.url) === asked || canonicalUrl(r.finalUrl) === asked) : undefined;
    if (!read) return null;
    return validateItemList({ url: read.url, source: read.file ? "file" : "page", items: answer.items }, textOf(pages));
  };
  const answer = await ask(itemsAnswerSchema, buildItemsPrompt(source, [], pages), "Research · items", ITEM_ANSWER_MS, (a) => itemListFacts(resolve(a), claimed));
  return { list: answer ? resolve(answer) : null, counts, costUsd };
}

// ---------------------------------------------------------------------------------------------------------------
// The item finder, until the structure finder replaces it (it is removed with its last caller)

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
 * Search → read → where, then `readItemListAt` on the address the where call chose (its list page, else the first
 * address it asked to read in full). Outside the arm's budget, each stage on its own clock. Nothing here throws except
 * a provider refusal on the user's own key.
 */
export function createItemFinder(options: ItemFinderOptions): ItemFinder {
  const modelId = (typeof options.model === "string" ? options.model : DEFAULT_RESEARCH_MODEL) as AiModelId;
  const languageModel = options.model === undefined || typeof options.model === "string" ? undefined : options.model;
  return {
    async find(source, ctx) {
      const counts: ResearchCounts = { searches: 0, fetches: 0 };
      let costUsd = 0;
      const none = (): ItemFinderResult => ({ list: null, counts, costUsd });
      const clock = (ms: number) => (ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
      const noun = nounOf(source);
      const ask = modelAsker({ modelId, languageModel, effort: options.effort }, ctx, (cost) => (costUsd += cost));

      // 1. Searching and reading: the source's own page while two searches run, then the best results.
      const gather = clock(ITEM_GATHER_MS);
      const tried = new Set<string>();
      const readShared = async (url: string): Promise<Read | null> => {
        ctx.emit({ type: "research.reading", url });
        counts.fetches += 1;
        const outcome = await ctx.fetcher.fetch(url, gather);
        ctx.emit({ type: "research.fetch", url, ok: outcome.ok, ...(outcome.ok ? {} : { reason: outcome.reason }) });
        return outcome.ok ? { url, finalUrl: outcome.page.finalUrl, text: outcome.page.text, full: false, file: false, truncated: false } : null;
      };
      const ownUrl = source.url.trim();
      const ownKey = ownUrl.toLowerCase().startsWith("https://") ? canonicalUrl(ownUrl) : null;
      if (ownKey) tried.add(ownKey);
      const own = ownKey ? readShared(ownUrl) : Promise.resolve(null);
      const title = mainTitle(source.title);
      const queries = [`${title} full list of ${noun}`, `${title} ${noun} list repository data file`];
      const found = await Promise.all(
        queries.map(async (query) => {
          counts.searches += 1;
          try {
            const results = await options.provider.search(query, { signal: gather, maxResults: ITEM_FINDER_RESULTS });
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
      const ownRead = await own;
      if (ownRead) reads.push(ownRead);
      const next: string[] = [];
      for (const r of results) {
        if (reads.length + next.length >= ITEM_FIRST_READS) break;
        const url = r.url.trim();
        const key = canonicalUrl(url);
        if (!url.toLowerCase().startsWith("https://") || !key || tried.has(key)) continue;
        tried.add(key);
        next.push(url);
      }
      if (!gather.aborted) for (const r of await Promise.all(next.map(readShared))) if (r) reads.push(r);
      if (reads.length === 0) return none();

      // 2. Where the whole list is.
      const locate = await ask(locateAnswerSchema, buildLocatePrompt(source, results, reads), "Research · items · where", ITEM_LOCATE_MS, (a) => [
        ...(a.list ? [`list on ${a.list}`] : []),
        ...a.read.map((u) => `asks to read ${u}`),
      ]);
      if (!locate) return none();
      const url = (locate.list ?? locate.read[0] ?? "").trim();
      if (!url) return none();

      // 3. Reading it.
      const read = await readItemListAt(source, url, ctx, {
        model: options.model,
        effort: options.effort,
        read: options.read,
        pages: reads.map(({ url, finalUrl, text }) => ({ url, finalUrl, text })),
      });
      counts.fetches += read.counts.fetches;
      costUsd += read.costUsd;
      return { list: read.list, counts, costUsd };
    },
  };
}
