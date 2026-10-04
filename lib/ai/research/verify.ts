import { z } from "zod";
import { detectSourceType, type SourceInput, type SourceType } from "@/lib/schemas/source";
import { MATERIAL_KINDS, clip, hostOf, shortId, type Material, type MaterialKind, type MinutesBasis } from "@/lib/schemas/material";
import type { Coverage, DroppedMaterial, ResearchEvent } from "./events";
import { signMaterial, signingSecret } from "./signature";
import type { FetchOutcome, SourceFetcher } from "./tools";

/**
 * The verification gate, shared by both research arms. A material enters the plan only if code fetched it in this
 * run and the page is what the candidate claims to be. Titles are never corrected: a mismatch drops the candidate.
 * A book is the exception: it is rarely readable online, so Open Library vouches for it by title and author, and
 * its own page is only the link when that page happens to pass.
 */

// ---------------------------------------------------------------------------------------------------------------
// What an arm proposes

export const candidateSchema = z.object({
  url: z.string().describe("The page for this material: its own page, not a page that mentions it"),
  title: z.string().describe("The material's title exactly as its own page gives it; for a book, its title as published"),
  kind: z.enum(MATERIAL_KINDS),
  author: z.string().nullable().optional(),
  year: z.number().nullable().optional(),
  backbone: z.boolean().describe("True only for the one textbook the plan should follow in order"),
  why: z.string().describe("One line: why this material, what it covers that the others don't"),
  recommendedBy: z.array(z.string()).describe("URLs of pages you saw that recommend it"),
  minutes: z.number().nullable().optional().describe("Minutes to read or watch the part of it this plan would use; null when you cannot tell"),
  uses: z.string().nullable().optional().describe('The part this plan would use when that is not the whole work, e.g. "ch. 1, 7–9"; null for the whole'),
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
});
export type LearnerNote = z.infer<typeof learnerNoteSchema>;

export const candidateListSchema = z.object({
  learner: z.array(learnerNoteSchema).describe("One entry per source the learner provided, in their order"),
  candidates: z.array(candidateSchema).describe("The researched materials, the backbone first"),
  coverage: z
    .object({
      covered: z.array(z.string()).describe("The topic's main areas that the list covers, one to three words each"),
      open: z.array(z.string()).describe("Main areas of the topic that nothing on the list covers"),
    })
    .optional(),
});
export type CandidateList = z.infer<typeof candidateListSchema>;

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
}

export class BookLookupUnavailable extends Error {}

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  number_of_pages_median?: number;
}

function authorsOverlap(claimed: string | null, authors: string[]): boolean {
  if (!claimed || authors.length === 0) return true;
  const want = new Set(titleTokens(claimed));
  return authors.some((a) => titleTokens(a).some((t) => want.has(t)));
}

export function pickBookMatch(title: string, author: string | null, docs: OpenLibraryDoc[]): BookMatch | null {
  for (const doc of docs) {
    if (!doc.title) continue;
    const matched = titleMatches(title, [doc.title]).ok || titleMatches(doc.title, [title]).ok;
    if (!matched || !authorsOverlap(author, doc.author_name ?? [])) continue;
    const key = typeof doc.key === "string" && /^\/works\/OL\d+W$/.test(doc.key) ? doc.key : null;
    const pages = typeof doc.number_of_pages_median === "number" && doc.number_of_pages_median > 0 ? doc.number_of_pages_median : null;
    return { key, title: doc.title, authors: doc.author_name ?? [], year: doc.first_publish_year ?? null, pages };
  }
  return null;
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
        headers: { "user-agent": "PensieveResearch/1.0 (study-plan source checker)" },
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
      const main = mainTitle(title);
      const withAuthor = author ? await query({ title: main, author }, signal) : [];
      const hit = pickBookMatch(title, author, withAuthor);
      if (hit) return hit;
      return pickBookMatch(title, author, await query({ title: main }, signal));
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
}

/**
 * How long a material takes, and whether code measured it. A video's runtime, a book's page count and an essay's
 * own length are counted; everything else (courses, docs sites, repos, a part of a larger work) is the model's
 * estimate. An estimate for part of a measured work never exceeds the whole.
 */
export function sizeMaterial(input: SizeInput): { minutes: number | null; basis: MinutesBasis | null } {
  const claimed = validMinutes(input.claimedMinutes);
  let whole: number | null = null;
  if (input.kind === "video") whole = validMinutes(input.durationMinutes);
  else if (input.kind === "book" && input.bookPages) whole = validMinutes(input.bookPages * MINUTES_PER_PAGE);
  else if (input.kind === "essay" && (input.words ?? 0) >= MIN_MEASURED_WORDS) whole = validMinutes((input.words ?? 0) / WORDS_PER_MINUTE);

  if (whole !== null && !input.uses) return { minutes: whole, basis: "measured" };
  if (whole !== null) return { minutes: claimed ? Math.min(claimed, whole) : whole, basis: "estimated" };
  return claimed ? { minutes: claimed, basis: "estimated" } : { minutes: null, basis: null };
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

interface Accepted {
  material: Omit<Material, "id">;
  /** Open Library matched this book, so it may be the backbone. */
  bookMatched: boolean;
  wantsBackbone: boolean;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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
    const entry: Accepted = {
      material: {
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
        ...sizeFields({ kind, uses: null, claimedMinutes: note?.minutes, words: fetched?.page.words, durationMinutes: fetched?.page.durationMinutes }),
        uses: null,
      },
      bookMatched: false,
      wantsBackbone: false,
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
    if (readable(c) || c.kind === "book") return true;
    drop(c.title, "not an https address", c.url);
    return false;
  });
  const outcomes = await mapLimit(valid, input.concurrency ?? 6, async (c): Promise<FetchOutcome> =>
    readable(c) ? fetchAnnounced(input, c.url.trim()) : { ok: false, url: c.url, reason: "not an https address" },
  );
  const bookChecks = await mapLimit(valid, 4, async (c) => {
    if (c.kind !== "book") return null;
    try {
      return { match: await input.books.find(c.title, c.author ?? null, input.signal), unavailable: false };
    } catch {
      return { match: null, unavailable: true };
    }
  });

  const accepted: Accepted[] = [];
  const byFinalUrl = new Map<string, Accepted>();
  valid.forEach((c, i) => {
    let page = checkPage(c, outcomes[i], threshold);
    let year = validYear(c.year);
    let bookMatched = false;
    let bookPages: number | null = null;
    if (c.kind === "book") {
      const check = bookChecks[i];
      if (check?.match) {
        bookMatched = true;
        year = check.match.year ?? year;
        bookPages = check.match.pages ?? null;
        // The book is real. If its own page cannot be used, its Open Library entry is the link.
        if (!page.ok) page = catalogueEntry(check.match, c.author, now) ?? page;
      } else if (check?.unavailable) {
        // With a page that passes, keep the book but unmatched: no Open Library year, and never the backbone.
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
    const size = { ...sizeFields({ kind: c.kind, uses, claimedMinutes: c.minutes, words: ownPage?.words, durationMinutes: ownPage?.durationMinutes, bookPages }), uses };

    // A candidate that is one of the learner's own sources enriches it instead of duplicating it.
    const mine = learnerByUrl.get(finalUrl) ?? learnerByUrl.get(canonicalUrl(c.url) ?? c.url);
    if (mine) {
      Object.assign(mine.material, { ...fields, why: mine.material.why ?? fields.why, ...(mine.material.minutes ? {} : size) });
      mine.bookMatched = bookMatched;
      mine.wantsBackbone = c.backbone;
      return;
    }
    const dup = byFinalUrl.get(finalUrl);
    if (dup) {
      dup.material.recommendedBy = [...new Set([...dup.material.recommendedBy, ...recommendedBy])].slice(0, 10);
      dup.wantsBackbone ||= c.backbone;
      return;
    }
    const entry: Accepted = {
      material: {
        origin: "research",
        type: VIDEO_HOSTS.test(hostOf(finalUrl) ?? "") ? "youtube" : "link",
        ...fields,
        url: finalUrl,
        title: clip(c.title, 300)!,
        backbone: false,
        verifiedAt,
        fetchedTitle,
        sig: signMaterial({ url: finalUrl, fetchedTitle, verifiedAt }, secret),
        ...size,
      },
      bookMatched,
      wantsBackbone: c.backbone,
    };
    accepted.push(entry);
    byFinalUrl.set(finalUrl, entry);
  });

  // 3. Backbone: a matched book that pages on at least two other sites recommend. The arm's pick wins if it qualifies.
  const all = [...learner, ...accepted];
  const qualifying = all
    .filter((a) => a.material.kind === "book" && a.bookMatched)
    .map((a) => ({ a, domains: recommendingDomains(a.material.url, a.material.recommendedBy).length }))
    .filter((q) => q.domains >= BACKBONE_MIN_DOMAINS);
  const backbone =
    qualifying.find((q) => q.a.wantsBackbone)?.a ??
    [...qualifying].sort((x, y) => y.domains - x.domains)[0]?.a ??
    null;
  if (backbone) backbone.material.backbone = true;

  // 4. Order: backbone, then the learner's sources, then the rest as the arm ranked them. Ids follow that order.
  const ordered = [...(backbone ? [backbone] : []), ...learner.filter((a) => a !== backbone), ...accepted.filter((a) => a !== backbone)];
  const materials: Material[] = ordered.map((a, i) => ({ id: shortId(i), ...a.material }));
  for (const m of materials) {
    if (m.origin === "research") {
      input.emit({ type: "research.verified", id: m.id, title: m.title, kind: m.kind, backbone: m.backbone, minutes: m.minutes ?? null, basis: m.minutesBasis ?? null });
    }
  }
  return { materials, dropped, verified: accepted.length, proposed: valid.length };
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
  let page = checkPage(claim, await fetcher.fetch(material.url, signal), TITLE_MATCH_THRESHOLD);
  let year = material.year;
  let backbone = material.backbone;
  if (researched && material.kind === "book") {
    try {
      const hit = await books.find(material.title, material.author, signal);
      if (!hit) return null;
      year = hit.year ?? year;
      if (!page.ok) page = catalogueEntry(hit, material.author, now) ?? page;
    } catch {
      year = null;
      backbone = false;
    }
  }
  if (!page.ok) return null;
  const { url, fetchedTitle, verifiedAt } = page;
  return { ...material, url, year, backbone, fetchedTitle, verifiedAt, sig: signMaterial({ url, fetchedTitle, verifiedAt }, secret) };
}
