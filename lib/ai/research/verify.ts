import { z } from "zod";
import { detectSourceType, type SourceInput, type SourceType } from "@/lib/schemas/source";
import { FOUND_BY, MATERIAL_KINDS, clip, hostOf, shortId, type ChapterList, type FoundBy, type Material, type MaterialKind, type MaterialPractice, type MinutesBasis } from "@/lib/schemas/material";
import { PRACTICE_REGISTRY, type PracticeFormatSpec } from "@/lib/practice";
import type { Coverage, DroppedMaterial, ResearchEvent } from "./events";
import { signMaterial, signingSecret } from "./signature";
import type { PageInfo } from "./extract";
import type { FetchOutcome, SourceFetcher } from "./tools";
import { parseOpenLibraryToc, withChapterSizes, type OpenLibraryTocEntry } from "./chapters";

/**
 * The verification gate, shared by both research arms. A material enters the plan only if code fetched it in this
 * run and the page is what the candidate claims to be. Titles are never corrected: a mismatch drops the candidate.
 * A book is the exception: it is rarely readable online, so Open Library vouches for it by title and author, and
 * its own page is only the link when that page happens to pass.
 */

// ---------------------------------------------------------------------------------------------------------------
// What an arm proposes

/** What the model writes when a source is also practice. Looser than `MaterialPractice`; `normalizePractice` bounds it. */
export const practiceDraftSchema = z.object({
  format: z.string().describe("One of the practice formats named in the prompt"),
  items: z.number().nullable().optional().describe("Problems, questions or steps the source holds that this plan would use; null when it is not counted"),
  perItemMinutes: z.number().nullable().optional().describe("Minutes per item if the source says so; null to use the format's usual"),
  answers: z.boolean().describe("True only if the source carries answers, solutions or a rubric"),
});
export type PracticeDraft = z.infer<typeof practiceDraftSchema>;

export { FOUND_BY, type FoundBy };

/** The most sources one candidates call may list; more are cut after the call, in the order the model gave them. */
export const MAX_CANDIDATES = 25;

export const candidateSchema = z.object({
  url: z.string().describe("The page for this material: its own page, not a page that mentions it; empty for a book whose own page the notes do not give"),
  title: z.string().describe("For a book, its title as published, with its author in the author field; otherwise the page's own title, exactly as the page gives it"),
  pageTitle: z.string().nullable().optional().describe("For a book, the title its web page shows, when the notes give one; null otherwise"),
  kind: z.enum(MATERIAL_KINDS),
  author: z.string().nullable().optional(),
  year: z.number().nullable().optional(),
  foundBy: z.array(z.enum(FOUND_BY)).optional().describe("The research directions whose notes mention it; left out when the notes are not grouped by direction"),
  why: z.string().describe("One line: why this material, what it covers that the others don't"),
  recommendedBy: z.array(z.string()).describe("URLs of pages you saw that recommend it"),
  minutes: z.number().nullable().optional().describe("Minutes to read or watch the part of it this plan would use; null when you cannot tell"),
  uses: z.string().nullable().optional().describe('The part this plan would use when that is not the whole work, e.g. "ch. 1, 7–9"; null for the whole'),
  practice: practiceDraftSchema.optional().describe("Set when the source is practice to do, alone or besides reading; leave out for reading only"),
});
export type Candidate = z.infer<typeof candidateSchema>;

/** The model's description of one of the learner's own sources. They are always kept. */
export const learnerNoteSchema = z.object({
  url: z.string(),
  kind: z.enum(MATERIAL_KINDS),
  title: z.string().optional(),
  author: z.string().nullable().optional(),
  year: z.number().nullable().optional(),
  why: z.string(),
  minutes: z.number().nullable().optional().describe("Minutes to read or watch it; null when you cannot tell"),
  practice: practiceDraftSchema.optional().describe("Set when the learner's source is practice to do (a problem list, a question bank); leave out for reading"),
});
export type LearnerNote = z.infer<typeof learnerNoteSchema>;

export const candidateListSchema = z.object({
  learner: z.array(learnerNoteSchema).describe("One entry per source the learner provided, in their order"),
  candidates: z.array(candidateSchema).describe(`Every credible source the notes found, once each; at most ${MAX_CANDIDATES}, the best-evidenced if there are more`),
  coverage: z
    .object({
      covered: z.array(z.string()).describe("The topic's main areas that the list covers, one to three words each"),
      open: z.array(z.string()).describe("Main areas of the topic that nothing on the list covers"),
    })
    .optional(),
});
export type CandidateList = z.infer<typeof candidateListSchema>;

/** The first `MAX_CANDIDATES` of a list. The schema states the bound to the model but does not reject a longer answer. */
export function capCandidates<T>(candidates: T[]): T[] {
  return candidates.length > MAX_CANDIDATES ? candidates.slice(0, MAX_CANDIDATES) : candidates;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure checks

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "for", "to", "in", "on", "with", "by", "at", "from", "or", "your", "vs", "edition", "ed"]);

/** Lower-cased word tokens without stopwords; runs of CJK characters become bigrams so unspaced titles still compare. */
export function titleTokens(text: string): string[] {
  const out: string[] = [];
  const normalized = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  for (const word of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(word)) {
      const chars = [...word];
      if (chars.length === 1) out.push(word);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
      continue;
    }
    if (STOPWORDS.has(word)) continue;
    if (word.length < 2 && !/\d/.test(word)) continue;
    out.push(word);
  }
  return out;
}

/** The part before a subtitle separator: "AI Engineering: Building Applications…" → "AI Engineering". */
export function mainTitle(title: string): string {
  return title.split(/\s*(?::|\s[-–—|]\s|：)\s*/)[0] ?? title;
}

/** Share of the claimed title's tokens that the page title contains. */
export function tokenRecall(claimed: string, page: string): { share: number; hits: number; size: number } {
  const want = new Set(titleTokens(claimed));
  const have = new Set(titleTokens(page));
  let hits = 0;
  for (const t of want) if (have.has(t)) hits += 1;
  return { share: want.size === 0 ? 0 : hits / want.size, hits, size: want.size };
}

/** Tuned on the first eval run; see the spec's open items. */
export const TITLE_MATCH_THRESHOLD = 0.6;

/**
 * Whether one of the page's own titles (`<title>`, `og:title`, first `<h1>`) carries the claimed title. The claim
 * matches in full or by its main title, so a page that drops the subtitle, or adds a site name, still matches.
 */
export function titleMatches(
  claimed: string,
  pageTitles: (string | null)[],
  threshold = TITLE_MATCH_THRESHOLD,
): { ok: boolean; matched: string | null } {
  const claims = [...new Set([claimed, mainTitle(claimed)])].filter((c) => titleTokens(c).length > 0);
  for (const page of pageTitles) {
    if (!page) continue;
    for (const claim of claims) {
      const r = tokenRecall(claim, page);
      if (r.share >= threshold && r.hits >= Math.min(2, r.size)) return { ok: true, matched: page };
    }
  }
  return { ok: false, matched: pageTitles.find(Boolean) ?? null };
}

const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/;
const CODE_HOSTS = /(^|\.)(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)$/;
const PAPER_HOSTS = /(^|\.)(arxiv\.org|openreview\.net|aclanthology\.org|dl\.acm\.org|papers\.nips\.cc|proceedings\.neurips\.cc|proceedings\.mlr\.press|ieeexplore\.ieee\.org|semanticscholar\.org|biorxiv\.org|ssrn\.com)$/;

const SHOP_HOSTS = /(^|\.)(amazon\.[a-z.]+|ebay\.[a-z.]+|barnesandnoble\.com|bookshop\.org|abebooks\.[a-z.]+|thriftbooks\.com|walmart\.com|booksamillion\.com|goodreads\.com|audible\.[a-z.]+)$/;

/** Whether a page sells or rates a book rather than being its publisher's or author's: never a book's own page. */
export function isShopListing(url: string): boolean {
  return SHOP_HOSTS.test(hostOf(url) ?? "");
}

/** Whether a claimed kind is plausible for where the page lives. `null` means plausible. */
export function kindProblem(kind: MaterialKind, url: string): string | null {
  const host = hostOf(url) ?? "";
  if (VIDEO_HOSTS.test(host)) return kind === "video" || kind === "course" ? null : `a ${kind} is unlikely on ${host}`;
  if (CODE_HOSTS.test(host)) return kind === "repo" || kind === "tool" ? null : `a ${kind} is unlikely on ${host}`;
  if (PAPER_HOSTS.test(host)) return kind === "paper" ? null : `a ${kind} is unlikely on ${host}`;
  if (kind === "repo") return `a repo should live on a code host, not ${host}`;
  return null;
}

/** The kind a learner's source gets when the model did not describe it. */
export function learnerKind(type: SourceType, url: string): MaterialKind {
  if (type === "youtube") return "video";
  if (type === "note" || type === "file") return "note";
  const host = hostOf(url) ?? "";
  if (CODE_HOSTS.test(host)) return "repo";
  if (PAPER_HOSTS.test(host)) return "paper";
  return "docs";
}

const TRACKING_PARAMS = /^(utm_\w+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid)$/i;

/** One URL per page: https, no `www.`, no fragment, no tracking parameters, no trailing slash. */
export function canonicalUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
  const search = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "";
  return `https://${u.hostname.toLowerCase().replace(/^www\./, "")}${path}${search}`;
}

/** Suffixes under which each label is its own registrant (a subset of the public suffix list that matters here). */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "ac.uk", "org.uk", "gov.uk", "com.au", "edu.au", "org.au", "net.au", "co.jp", "ac.jp", "or.jp",
  "com.br", "com.cn", "edu.cn", "org.cn", "co.in", "ac.in", "co.nz", "co.kr", "ac.kr", "com.sg", "edu.sg",
  "com.hk", "com.tw", "edu.tw", "co.za", "com.mx", "github.io", "gitlab.io", "readthedocs.io", "blogspot.com",
  "vercel.app", "netlify.app", "pages.dev", "herokuapp.com",
]);

export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** Distinct registrable domains among the recommending pages, not counting the material's own site. */
export function recommendingDomains(url: string, recommendedBy: string[]): string[] {
  const own = registrableDomain(hostOf(url) ?? "");
  const domains = new Set<string>();
  for (const r of recommendedBy) {
    const host = hostOf(r);
    if (!host) continue;
    const d = registrableDomain(host);
    if (d !== own) domains.add(d);
  }
  return [...domains];
}

export const BACKBONE_MIN_DOMAINS = 2;

// ---------------------------------------------------------------------------------------------------------------
// Open Library

export interface BookMatch {
  /** The work's path on Open Library (`/works/OL…W`), or null when the catalogue gave none. */
  key: string | null;
  title: string;
  authors: string[];
  year: number | null;
  /** The median page count across editions, when the catalogue has one. */
  pages?: number | null;
}

/** Finds a book by title and author. Throws when the service is unavailable; resolves null when there is no match. */
export interface BookLookup {
  find(title: string, author: string | null, signal?: AbortSignal): Promise<BookMatch | null>;
  /**
   * The work's chapter list from the edition with the longest usable table of contents; null when none has one, when
   * the match has no work key, or on any failure. Optional so small fakes stay small.
   */
  chapters?(match: BookMatch, signal?: AbortSignal): Promise<ChapterList | null>;
}

export class BookLookupUnavailable extends Error {}

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  number_of_pages_median?: number;
}

interface OpenLibraryEdition {
  key?: string;
  title?: string;
  number_of_pages?: number;
  table_of_contents?: OpenLibraryTocEntry[];
}

const OPEN_LIBRARY_USER_AGENT = "PensieveResearch/1.0 (study-plan source checker)";

function authorsOverlap(claimed: string | null, authors: string[]): boolean {
  if (!claimed || authors.length === 0) return true;
  const want = new Set(titleTokens(claimed));
  return authors.some((a) => titleTokens(a).some((t) => want.has(t)));
}

/**
 * The title to ask the catalogue for: the main title without asides in brackets. A claim copied from a book's web
 * page ("Designing Data-Intensive Applications (DDIA) — an O'Reilly book…") finds nothing until the extras go.
 */
export function searchTitle(title: string): string {
  const main = mainTitle(title);
  const bare = main.replace(/\s*(?:\([^)]*\)|\[[^\]]*\])/g, "").trim();
  return bare || main;
}

/** How closely two titles agree, from 0 to 1: shared tokens over both titles' tokens, at their best forms. */
function titleCloseness(claimed: string, found: string): number {
  let best = 0;
  for (const a of new Set([claimed, mainTitle(claimed), searchTitle(claimed)])) {
    for (const b of new Set([found, mainTitle(found)])) {
      const r = tokenRecall(a, b);
      const size = r.size + new Set(titleTokens(b)).size;
      if (size > 0) best = Math.max(best, (2 * r.hits) / size);
    }
  }
  return best;
}

/**
 * The catalogue entry for a claimed book: of the docs whose title and author agree with the claim, the closest
 * title, so "System Design Interview" by Alex Xu is not "Machine Learning System Design Interview", which he
 * co-wrote and the catalogue lists first. A tie keeps the catalogue's order.
 */
export function pickBookMatch(title: string, author: string | null, docs: OpenLibraryDoc[]): BookMatch | null {
  let best: { doc: OpenLibraryDoc & { title: string }; closeness: number } | null = null;
  for (const doc of docs) {
    if (!doc.title) continue;
    const matched = titleMatches(title, [doc.title]).ok || titleMatches(doc.title, [title]).ok;
    if (!matched || !authorsOverlap(author, doc.author_name ?? [])) continue;
    const closeness = titleCloseness(title, doc.title);
    if (!best || closeness > best.closeness) best = { doc: { ...doc, title: doc.title }, closeness };
  }
  if (!best) return null;
  const { doc } = best;
  const key = typeof doc.key === "string" && /^\/works\/OL\d+W$/.test(doc.key) ? doc.key : null;
  const pages = typeof doc.number_of_pages_median === "number" && doc.number_of_pages_median > 0 ? doc.number_of_pages_median : null;
  return { key, title: doc.title, authors: doc.author_name ?? [], year: doc.first_publish_year ?? null, pages };
}

export function createOpenLibraryLookup(fetchImpl: typeof fetch = fetch): BookLookup {
  const query = async (params: Record<string, string>, signal?: AbortSignal): Promise<OpenLibraryDoc[]> => {
    const url = new URL("https://openlibrary.org/search.json");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("limit", "5");
    url.searchParams.set("fields", "key,title,author_name,first_publish_year,number_of_pages_median");
    const timeout = AbortSignal.timeout(5_000);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { "user-agent": OPEN_LIBRARY_USER_AGENT },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new BookLookupUnavailable(error instanceof Error ? error.message : "Open Library unreachable");
    }
    if (!res.ok) throw new BookLookupUnavailable(`Open Library returned ${res.status}`);
    const json = (await res.json().catch(() => null)) as { docs?: OpenLibraryDoc[] } | null;
    if (!json || !Array.isArray(json.docs)) throw new BookLookupUnavailable("Open Library returned an unexpected body");
    return json.docs;
  };
  return {
    async find(title, author, signal) {
      const search = searchTitle(title);
      const withAuthor = author ? await query({ title: search, author }, signal) : [];
      const hit = pickBookMatch(title, author, withAuthor);
      if (hit) return hit;
      return pickBookMatch(title, author, await query({ title: search }, signal));
    },
    async chapters(match, signal) {
      if (!match.key) return null;
      try {
        const timeout = AbortSignal.timeout(5_000);
        const res = await fetchImpl(`https://openlibrary.org${match.key}/editions.json?limit=50`, {
          headers: { "user-agent": OPEN_LIBRARY_USER_AGENT },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!res.ok) return null;
        const json = (await res.json().catch(() => null)) as { entries?: OpenLibraryEdition[] } | null;
        if (!json || !Array.isArray(json.entries)) return null;
        // An edition whose title matches the work's is in the work's language; a translation's longer list loses to it.
        let best: { toc: ChapterList; sameTitle: boolean } | null = null;
        for (const edition of json.entries) {
          if (typeof edition.key !== "string" || !Array.isArray(edition.table_of_contents)) continue;
          const pages = typeof edition.number_of_pages === "number" && edition.number_of_pages > 0 ? edition.number_of_pages : null;
          const toc = parseOpenLibraryToc(edition.table_of_contents, { url: `https://openlibrary.org${edition.key}`, numberOfPages: pages });
          if (!toc) continue;
          const sameTitle = titleMatches(match.title, [edition.title ?? null]).ok;
          if (!best || (sameTitle && !best.sameTitle) || (sameTitle === best.sameTitle && toc.chapters.length > best.toc.chapters.length)) best = { toc, sameTitle };
        }
        return best?.toc ?? null;
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Sizes

/** Reading speeds used to turn what code can count into minutes. Deliberately unhurried: this is study, not skimming. */
export const WORDS_PER_MINUTE = 230;
export const MINUTES_PER_PAGE = 2.5;
/** A page shorter than this is a landing page or an abstract, not the essay itself. */
export const MIN_MEASURED_WORDS = 600;
/** A page that links to at least this many other pages of its own site is a hub, not the work itself. */
export const HUB_MIN_LINKS = 6;
const MAX_MINUTES = 60_000;

function validMinutes(minutes: number | null | undefined): number | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.min(MAX_MINUTES, Math.max(1, Math.round(minutes)));
}

export interface SizeInput {
  kind: MaterialKind;
  /** The part the plan uses, when not the whole work. */
  uses: string | null;
  /** What the model said it takes. */
  claimedMinutes: number | null | undefined;
  /** What the material's own page showed, when it was read. */
  words?: number | null;
  durationMinutes?: number | null;
  /** A matched book's page count from the catalogue. */
  bookPages?: number | null;
  /** True when the material's own page mostly links to the rest of its site, so its length is not the work's. */
  hub?: boolean;
}

/**
 * What the material's own page measures, whatever the material's size came to: a video's runtime, a book's catalogue
 * pages, else the page's words at reading speed. Null when the page measures nothing.
 */
export function pageMinutesOf(page: Pick<PageInfo, "words" | "durationMinutes">, kind: MaterialKind, bookPages?: number | null): number | null {
  if (kind === "video") return validMinutes(page.durationMinutes);
  if (kind === "book" && bookPages) return validMinutes(bookPages * MINUTES_PER_PAGE);
  return (page.words ?? 0) > 0 ? validMinutes((page.words ?? 0) / WORDS_PER_MINUTE) : null;
}

/**
 * How long a material takes, and whether code measured it. A video's runtime, a book's page count and the own length
 * of an essay or paper, or of a repo whose README is the work, are counted; everything else (courses, docs sites,
 * hub repos, a part of a larger work) is the model's estimate. An estimate for part of a measured work never exceeds the whole.
 */
export function sizeMaterial(input: SizeInput): { minutes: number | null; basis: MinutesBasis | null } {
  const claimed = validMinutes(input.claimedMinutes);
  let whole: number | null = null;
  if (input.kind === "video") whole = validMinutes(input.durationMinutes);
  else if (input.kind === "book" && input.bookPages) whole = validMinutes(input.bookPages * MINUTES_PER_PAGE);
  else if ((input.kind === "essay" || input.kind === "paper" || (input.kind === "repo" && !input.hub)) && (input.words ?? 0) >= MIN_MEASURED_WORDS) whole = validMinutes((input.words ?? 0) / WORDS_PER_MINUTE);

  if (whole !== null && !input.uses) return { minutes: whole, basis: "measured" };
  if (whole !== null) return { minutes: claimed ? Math.min(claimed, whole) : whole, basis: "estimated" };
  return claimed ? { minutes: claimed, basis: "estimated" } : { minutes: null, basis: null };
}

/**
 * Bounds and sizes what the model wrote about a source as practice. Null for a format the registry does not know and
 * for a format that needs answers when the source has none. Doing time is items times minutes per item when the items
 * are known, else the format's fixed block, else unknown.
 */
export function normalizePractice(draft: PracticeDraft, registry: Record<string, PracticeFormatSpec> = PRACTICE_REGISTRY): MaterialPractice | null {
  const spec = Object.hasOwn(registry, draft.format) ? registry[draft.format] : null;
  if (!spec || (spec.needsAnswers && !draft.answers)) return null;
  const bound = (n: number | null | undefined, max: number) => (typeof n === "number" && Number.isFinite(n) && Math.round(n) >= 1 ? Math.min(max, Math.round(n)) : null);
  const items = bound(draft.items, 5000);
  const perItemMinutes = bound(draft.perItemMinutes, 600) ?? spec.perItemMinutes;
  const minutes = items !== null && perItemMinutes !== null ? Math.min(60000, items * perItemMinutes) : spec.fixedMinutes;
  return { format: spec.id, items, perItemMinutes, minutes, answers: draft.answers };
}

/** Minutes of material on a list, over the materials that have a size. */
export function sizedMinutes(materials: Pick<Material, "minutes">[]): number {
  return materials.reduce((sum, m) => sum + (m.minutes ?? 0), 0);
}

/** Trims the areas research named and drops repeats; null when it named none. */
export function normalizeCoverage(coverage: { covered?: string[]; open?: string[] } | null | undefined): Coverage | null {
  const tidy = (items: string[] | undefined) => [...new Set((items ?? []).map((a) => clip(a, 40)).filter((a): a is string => !!a))].slice(0, 10);
  const covered = tidy(coverage?.covered);
  const open = tidy(coverage?.open).filter((a) => !covered.includes(a));
  return covered.length + open.length > 0 ? { covered, open } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// The gate

export interface GateInput {
  candidates: Candidate[];
  learner: SourceInput[];
  learnerNotes: LearnerNote[];
  fetcher: SourceFetcher;
  books: BookLookup;
  /** URLs the arm actually saw (search results and pages read). `recommendedBy` entries outside it are removed. */
  seenUrls: Set<string>;
  emit: (event: ResearchEvent) => void;
  signal?: AbortSignal;
  secret?: string;
  titleThreshold?: number;
  concurrency?: number;
  now?: () => Date;
}

export interface GateResult {
  materials: Material[];
  dropped: DroppedMaterial[];
  /** How many researched (not learner) materials passed. */
  verified: number;
  /** Candidates proposed, after removing exact duplicates of the learner's own sources. */
  proposed: number;
}

/** A kept material before ids are given. */
type Accepted = Omit<Material, "id">;

/** Directions in `FOUND_BY` order, once each; undefined when there are none. */
function foundByOf(...lists: (readonly FoundBy[] | undefined)[]): FoundBy[] | undefined {
  const all = new Set(lists.flatMap((l) => l ?? []));
  const out = FOUND_BY.filter((d) => all.has(d));
  return out.length > 0 ? out : undefined;
}

/** For a match found by a book's page title: both sides name an author, and they share one. */
function authorsAgree(claimed: string | null | undefined, authors: string[]): boolean {
  return !!claimed?.trim() && authors.length > 0 && authorsOverlap(claimed, authors);
}

/** Runs `fn` over `items` at most `limit` at a time, results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** What a candidate's own page turned out to be, or why it cannot be used. */
type PageCheck =
  | { ok: true; url: string; fetchedTitle: string | null; verifiedAt: string; author: string | null }
  | { ok: false; reason: string };

/** The page must have opened, carry the claimed title, and live where its kind plausibly lives (`kind: null` skips that). */
function checkPage(claim: { url: string; title: string; kind: MaterialKind | null }, outcome: FetchOutcome, threshold: number): PageCheck {
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const match = titleMatches(claim.title, [outcome.page.title, outcome.page.ogTitle, outcome.page.h1], threshold);
  if (!match.ok) {
    const saw = match.matched ? `the page is titled “${clip(match.matched, 80)}”` : "the page has no title";
    return { ok: false, reason: `title doesn't match: ${saw}` };
  }
  const url = canonicalUrl(outcome.page.finalUrl) ?? canonicalUrl(claim.url) ?? claim.url;
  const kindIssue = claim.kind ? kindProblem(claim.kind, url) : null;
  if (kindIssue) return { ok: false, reason: kindIssue };
  return { ok: true, url, fetchedTitle: clip(match.matched, 300), verifiedAt: outcome.fetchedAt, author: outcome.page.author };
}

/**
 * A matched book's Open Library entry, standing in for a page of its own. With no page to confirm the claim, the
 * match has to rest on the author as well as the title, so both sides must name one.
 */
function catalogueEntry(match: BookMatch, claimedAuthor: string | null | undefined, now: () => Date): PageCheck | null {
  if (!match.key || !claimedAuthor?.trim() || match.authors.length === 0) return null;
  return { ok: true, url: `https://openlibrary.org${match.key}`, fetchedTitle: clip(match.title, 300), verifiedAt: now().toISOString(), author: null };
}

/** Why a catalogue match cannot stand in for a book's page: what `catalogueEntry` needs that the claim or the match lacks. */
function unconfirmedMatch(match: BookMatch, claimedAuthor: string | null | undefined): string {
  if (!claimedAuthor?.trim()) return "Open Library matched the title, but no author was given to confirm it";
  if (match.authors.length === 0) return "Open Library's match names no author to confirm it";
  return "Open Library's match has no work page";
}

/** A fetch the site turned away (a 401, 403 or 429) or that timed out: the page is there, it just would not serve a robot. */
const TURNED_AWAY = /^(?:returned (?:401|403|429)\b|timed out$)/;

/**
 * The page standing for a book Open Library matched when its own page did not pass. A claimed page the site turned
 * away stays the book's link, the catalogue vouching for the book; one that is gone, opened as something else, or
 * is a shop gives way to the catalogue entry. `pageReason` is null for a book claimed with no address.
 */
function bookPage(match: BookMatch, claim: { url: string; author?: string | null }, outcome: FetchOutcome, pageReason: string | null, now: () => Date): PageCheck {
  const entry = catalogueEntry(match, claim.author, now);
  if (!entry) return { ok: false, reason: pageReason ? `${pageReason}; ${unconfirmedMatch(match, claim.author)}` : unconfirmedMatch(match, claim.author) };
  const turnedAway = !outcome.ok && TURNED_AWAY.test(outcome.reason);
  const own = turnedAway && claim.url.trim().toLowerCase().startsWith("https://") && !isShopListing(claim.url) ? canonicalUrl(claim.url) : null;
  return own && entry.ok ? { ...entry, url: own } : entry;
}

function pageTitle(outcome: FetchOutcome & { ok: true }): string | null {
  return outcome.page.ogTitle ?? outcome.page.title ?? outcome.page.h1;
}

/** Fetches through the shared cache, announcing only the reads that actually go out. */
async function fetchAnnounced(input: GateInput, url: string): Promise<FetchOutcome> {
  const cached = input.fetcher.peek(url);
  if (cached) return cached;
  input.emit({ type: "research.reading", url });
  const outcome = await input.fetcher.fetch(url, input.signal);
  input.emit({ type: "research.fetch", url, ok: outcome.ok, ...(outcome.ok ? {} : { reason: outcome.reason }) });
  return outcome;
}

function learnerTitle(source: SourceInput, fetched: string | null): string {
  if (source.title?.trim()) return source.title.trim();
  if (source.type === "note" || source.type === "file") return source.url.trim();
  return fetched ?? hostOf(source.url) ?? source.url;
}

export async function runGate(input: GateInput): Promise<GateResult> {
  const secret = input.secret ?? signingSecret();
  const threshold = input.titleThreshold ?? TITLE_MATCH_THRESHOLD;
  const now = input.now ?? (() => new Date());
  const dropped: DroppedMaterial[] = [];
  const drop = (title: string, reason: string, url?: string) => {
    if (process.env.NODE_ENV !== "test") console.info(`[research] dropped "${title}"${url ? ` <${url}>` : ""}: ${reason}`);
    dropped.push({ title, url, reason });
    input.emit({ type: "research.dropped", title, url, reason });
  };

  // 1. The learner's own sources: always kept, read when they are links so their titles and badges are real.
  const learner: Accepted[] = [];
  const learnerByUrl = new Map<string, Accepted>();
  const notes = new Map(input.learnerNotes.map((n) => [canonicalUrl(n.url) ?? n.url, n]));
  const learnerSources = input.learner.filter((s, i, all) => all.findIndex((o) => o.url === s.url) === i);
  const learnerOutcomes = await mapLimit(learnerSources, input.concurrency ?? 6, async (s) =>
    (s.type === "link" || s.type === "youtube") && canonicalUrl(s.url) ? fetchAnnounced(input, s.url) : null,
  );
  learnerSources.forEach((source, i) => {
    const outcome = learnerOutcomes[i];
    const fetched = outcome?.ok ? outcome : null;
    const key = canonicalUrl(source.url) ?? source.url;
    const note = notes.get(key);
    const url = fetched ? (canonicalUrl(fetched.page.finalUrl) ?? source.url) : source.url;
    const fetchedTitle = fetched ? clip(pageTitle(fetched), 300) : null;
    const verifiedAt = fetched ? fetched.fetchedAt : null;
    const type = source.type ?? detectSourceType(source.url);
    const kind = note?.kind ?? learnerKind(type, source.url);
    const practice = note?.practice ? normalizePractice(note.practice) : null;
    const entry: Accepted = {
      origin: "learner",
      type,
      kind,
      url,
      title: clip(learnerTitle(source, fetchedTitle ?? note?.title ?? null), 300)!,
      author: clip(note?.author, 200),
      year: validYear(note?.year),
      why: clip(note?.why, 400),
      backbone: false,
      verifiedAt,
      fetchedTitle,
      recommendedBy: [],
      sig: verifiedAt ? signMaterial({ url, fetchedTitle, verifiedAt }, secret) : null,
      ...sizeFields({ kind, uses: null, claimedMinutes: note?.minutes, words: fetched?.page.words, durationMinutes: fetched?.page.durationMinutes, hub: isHub(fetched?.page) }),
      ...pageFields(fetched?.page, kind),
      uses: null,
      toc: null,
      ...(practice ? { practice } : {}),
      foundBy: ["learner"],
    };
    learner.push(entry);
    learnerByUrl.set(key, entry);
    if (fetched) learnerByUrl.set(canonicalUrl(fetched.page.finalUrl) ?? key, entry);
  });

  // 2. Researched candidates: read every one (the arm's reads are reused), then check what came back.
  const seen = new Set([...input.seenUrls].map((u) => canonicalUrl(u) ?? u));
  const readable = (c: Candidate) => !!canonicalUrl(c.url) && c.url.trim().toLowerCase().startsWith("https://");
  const valid = input.candidates.filter((c) => {
    // A book goes on without an address of its own: Open Library is what vouches for it.
    if (!(readable(c) || c.kind === "book")) {
      drop(c.title, "not an https address", c.url);
      return false;
    }
    // A source that is practice and nothing else is useless without answers to check against.
    if (c.practice && c.minutes == null && Object.hasOwn(PRACTICE_REGISTRY, c.practice.format) && !normalizePractice(c.practice)) {
      drop(c.title, "practice without answers", c.url);
      return false;
    }
    return true;
  });
  const outcomes = await mapLimit(valid, input.concurrency ?? 6, async (c): Promise<FetchOutcome> =>
    readable(c) ? fetchAnnounced(input, c.url.trim()) : { ok: false, url: c.url, reason: "not an https address" },
  );
  const bookChecks = await mapLimit(valid, 4, async (c) => {
    if (c.kind !== "book") return null;
    try {
      let match = await input.books.find(c.title, c.author ?? null, input.signal);
      // A book named only by its web page's title is found by that title, but only when the authors agree too.
      let byPageTitle = false;
      const shown = c.pageTitle?.trim();
      if (!match && shown && shown !== c.title.trim()) {
        const hit = await input.books.find(shown, c.author ?? null, input.signal);
        if (hit && authorsAgree(c.author, hit.authors)) {
          match = hit;
          byPageTitle = true;
        }
      }
      // Chapters are a bonus on top of the match: a failed lookup leaves the book verified without them.
      const toc = match && input.books.chapters ? await input.books.chapters(match, input.signal).catch(() => null) : null;
      return { match, byPageTitle, unavailable: false, toc };
    } catch {
      return { match: null, byPageTitle: false, unavailable: true, toc: null };
    }
  });

  const accepted: Accepted[] = [];
  const byFinalUrl = new Map<string, Accepted>();
  valid.forEach((c, i) => {
    let page = checkPage(c, outcomes[i], threshold);
    let year = validYear(c.year);
    let bookMatched = false;
    let bookPages: number | null = null;
    let toc: ChapterList | null = null;
    // The claimed title, or the catalogue's when only the page's title found the book.
    let title = c.title;
    if (c.kind === "book") {
      const check = bookChecks[i];
      if (check?.match) {
        bookMatched = true;
        if (check.byPageTitle) title = check.match.title;
        year = check.match.year ?? year;
        bookPages = check.match.pages ?? null;
        toc = check.toc;
        // The book is real. If its own page cannot be used, the page its site turned away or its Open Library entry is the link.
        if (!page.ok) page = bookPage(check.match, c, outcomes[i], readable(c) ? page.reason : null, now);
      } else if (check?.unavailable) {
        // With a page that passes, keep the book but not catalogued: no Open Library year, and never the backbone.
        year = null;
        if (!page.ok) page = { ok: false, reason: `${page.reason}; Open Library was unavailable` };
      } else {
        return drop(c.title, "no matching book on Open Library", c.url);
      }
    }
    if (!page.ok) return drop(c.title, page.reason, c.url);

    const recommendedBy = [...new Set(c.recommendedBy.map((r) => canonicalUrl(r)).filter((r): r is string => !!r && seen.has(r)))].slice(0, 10);
    const { url: finalUrl, fetchedTitle, verifiedAt } = page;
    const fields = {
      kind: c.kind,
      author: clip(c.author ?? page.author, 200),
      year,
      why: clip(c.why, 400),
      recommendedBy,
    };
    const outcome = outcomes[i];
    const uses = clip(c.uses, 120);
    // The page's own length counts only when the candidate's own page was read, not its catalogue entry.
    const ownPage = outcome.ok && checkPage(c, outcome, threshold).ok ? outcome.page : null;
    // A practice-only source is sized by its practice, never by its page: a course video's runtime is not reading.
    const size =
      c.practice && c.minutes == null
        ? { minutes: null, minutesBasis: null, uses }
        : { ...sizeFields({ kind: c.kind, uses, claimedMinutes: c.minutes, words: ownPage?.words, durationMinutes: ownPage?.durationMinutes, bookPages, hub: isHub(ownPage) }), uses };

    const practice = c.practice ? normalizePractice(c.practice) : null;

    // A candidate that is one of the learner's own sources enriches it instead of duplicating it.
    // The learner's own stays found by the learner.
    const mine = learnerByUrl.get(finalUrl) ?? learnerByUrl.get(canonicalUrl(c.url) ?? c.url);
    if (mine) {
      Object.assign(mine, { ...fields, why: mine.why ?? fields.why, ...(mine.minutes ? {} : size) });
      if (toc) mine.toc = withChapterSizes(toc, mine.minutes ?? null);
      if (bookMatched) mine.catalogued = true;
      if (practice && !mine.practice) mine.practice = practice;
      return;
    }
    const dup = byFinalUrl.get(finalUrl);
    if (dup) {
      dup.recommendedBy = [...new Set([...dup.recommendedBy, ...recommendedBy])].slice(0, 10);
      // Reading fields the kept material lacks come from this candidate, whichever was listed first; set ones stay.
      // A part qualifies the minutes it came with: it moves only with minutes taken, or from a candidate with none.
      const takesMinutes = !dup.minutes;
      if (takesMinutes) Object.assign(dup, { minutes: size.minutes, minutesBasis: size.minutesBasis });
      if (takesMinutes || size.minutes === null) dup.uses ??= size.uses;
      if (toc && !dup.toc) dup.toc = withChapterSizes(toc, dup.minutes ?? null);
      if (practice && !dup.practice) dup.practice = practice;
      if (bookMatched) dup.catalogued = true;
      const foundBy = foundByOf(dup.foundBy, c.foundBy);
      if (foundBy) dup.foundBy = foundBy;
      return;
    }
    const foundBy = foundByOf(c.foundBy);
    const entry: Accepted = {
      origin: "research",
      type: VIDEO_HOSTS.test(hostOf(finalUrl) ?? "") ? "youtube" : "link",
      ...fields,
      url: finalUrl,
      title: clip(title, 300)!,
      backbone: false,
      verifiedAt,
      fetchedTitle,
      sig: signMaterial({ url: finalUrl, fetchedTitle, verifiedAt }, secret),
      ...size,
      ...pageFields(ownPage, c.kind, bookPages),
      toc: toc ? withChapterSizes(toc, size.minutes) : null,
      ...(practice ? { practice } : {}),
      ...(bookMatched ? { catalogued: true } : {}),
      ...(foundBy ? { foundBy } : {}),
    };
    accepted.push(entry);
    byFinalUrl.set(finalUrl, entry);
  });

  // 3. Order: the learner's sources, then the rest as the arm ranked them. Ids follow that order. The backbone is the
  // allocation's choice, among catalogued books and the learner's own.
  const materials: Material[] = [...learner, ...accepted].map((m, i) => ({ id: shortId(i), ...m }));
  for (const m of materials) {
    if (m.origin === "research") {
      input.emit({ type: "research.verified", id: m.id, title: m.title, kind: m.kind, backbone: m.backbone, minutes: m.minutes ?? null, basis: m.minutesBasis ?? null });
    }
    if (m.toc) input.emit({ type: "research.chapters", id: m.id, title: m.title, chapters: m.toc.chapters.length, source: m.toc.source, url: m.toc.url });
  }
  return { materials, dropped, verified: accepted.length, proposed: valid.length };
}

/** True when a page mostly links to the rest of its site (see `HUB_MIN_LINKS`). */
function isHub(page: PageInfo | null | undefined): boolean {
  return (page?.siteLinks ?? 0) >= HUB_MIN_LINKS;
}

/** The draft-only fields of a material whose own page was read; none when it was not (the catalogue entry, a failed read). */
function pageFields(page: PageInfo | null | undefined, kind: MaterialKind, bookPages?: number | null): { pageMinutes?: number | null; hub?: boolean } {
  return page ? { pageMinutes: pageMinutesOf(page, kind, bookPages), hub: isHub(page) } : {};
}

function sizeFields(input: SizeInput): { minutes: number | null; minutesBasis: MinutesBasis | null } {
  const { minutes, basis } = sizeMaterial(input);
  return { minutes, minutesBasis: basis };
}

function validYear(year: number | null | undefined): number | null {
  if (typeof year !== "number" || !Number.isFinite(year)) return null;
  const y = Math.round(year);
  return y >= 1000 && y <= 2200 ? y : null;
}

/**
 * Re-checks one researched material whose signature failed on save: the page must still open and still carry the
 * title the material claims, or, for a book, Open Library must still match it. Returns the re-signed material, or
 * null to drop it.
 */
export async function reverifyMaterial(
  material: Material,
  fetcher: SourceFetcher,
  books: BookLookup,
  secret: string = signingSecret(),
  signal?: AbortSignal,
  now: () => Date = () => new Date(),
): Promise<Material | null> {
  const researched = material.origin === "research";
  const claim = { url: material.url, title: material.title, kind: researched ? material.kind : null };
  const outcome = await fetcher.fetch(material.url, signal);
  let page = checkPage(claim, outcome, TITLE_MATCH_THRESHOLD);
  let year = material.year;
  let backbone = material.backbone;
  if (researched && material.kind === "book") {
    try {
      const hit = await books.find(material.title, material.author, signal);
      if (!hit) return null;
      year = hit.year ?? year;
      if (!page.ok) page = bookPage(hit, material, outcome, page.reason, now);
    } catch {
      year = null;
      backbone = false;
    }
  }
  if (!page.ok) return null;
  const { url, fetchedTitle, verifiedAt } = page;
  return { ...material, url, year, backbone, fetchedTitle, verifiedAt, sig: signMaterial({ url, fetchedTitle, verifiedAt }, secret) };
}
