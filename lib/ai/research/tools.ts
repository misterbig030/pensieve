import { tool } from "ai";
import { z } from "zod";
import { describeEgressError, guardedFetch, type GuardedFetchOptions } from "./egress";
import { extractPage, type PageInfo } from "./extract";
import type { ResearchEvent } from "./events";

// ---------------------------------------------------------------------------------------------------------------
// Search

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate: string | null;
}

/** Where `webSearch` gets results. Tests pass a fake; the app uses Tavily. */
export interface SearchProvider {
  name: string;
  search(query: string, options: { signal?: AbortSignal; maxResults: number }): Promise<SearchResult[]>;
}

export class SearchProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchProviderError";
  }
}

export const SEARCH_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 10_000;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

/** Tavily's search endpoint. Only titles, URLs and snippets come back; pages are always read through the guard. */
export function createTavilyProvider(apiKey: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    name: "tavily",
    async search(query, { signal, maxResults }) {
      const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchImpl("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic", include_answer: false, include_raw_content: false }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        throw new SearchProviderError(timeout.aborted ? "Search timed out" : error instanceof Error ? error.message : "Search failed");
      }
      if (!res.ok) throw new SearchProviderError(`Search returned ${res.status}`);
      const json = (await res.json().catch(() => null)) as { results?: TavilyResult[] } | null;
      if (!json || !Array.isArray(json.results)) throw new SearchProviderError("Search returned an unexpected body");
      return json.results
        .filter((r): r is TavilyResult & { url: string } => typeof r.url === "string")
        .slice(0, maxResults)
        .map((r) => ({
          title: (r.title ?? r.url).slice(0, 300),
          url: r.url,
          snippet: (r.content ?? "").slice(0, 500),
          publishedDate: r.published_date ?? null,
        }));
    },
  };
}

/** The configured search provider, or null when `TAVILY_API_KEY` is unset (research then reports "unavailable"). */
export function searchProviderFromEnv(env: Record<string, string | undefined> = process.env): SearchProvider | null {
  const key = env.TAVILY_API_KEY?.trim();
  return key ? createTavilyProvider(key) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Fetch, cached per run

export type FetchOutcome =
  | { ok: true; url: string; page: PageInfo; fetchedAt: string }
  | { ok: false; url: string; reason: string };

export type PageFetcher = (url: string, signal?: AbortSignal) => Promise<PageInfo>;

export const guardedPageFetcher =
  (options: Omit<GuardedFetchOptions, "signal"> = {}): PageFetcher =>
  async (url, signal) =>
    extractPage(await guardedFetch(url, { ...options, signal }));

/**
 * Fetches pages through the guard and remembers every outcome for the rest of the run, keyed by both the requested
 * and the final URL. The agent's `fetchSource` and the verification gate share one of these, so the gate never
 * fetches a page twice.
 */
export class SourceFetcher {
  private readonly cache = new Map<string, Promise<FetchOutcome>>();
  constructor(
    private readonly fetchPage: PageFetcher = guardedPageFetcher(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Returns the cached outcome if this URL (or a page that redirected to it) was already fetched in this run. */
  peek(url: string): Promise<FetchOutcome> | undefined {
    return this.cache.get(cacheKey(url));
  }

  fetch(url: string, signal?: AbortSignal): Promise<FetchOutcome> {
    const key = cacheKey(url);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const pending = this.fetchPage(url, signal).then(
      (page): FetchOutcome => {
        const outcome: FetchOutcome = { ok: true, url, page, fetchedAt: this.now().toISOString() };
        const finalKey = cacheKey(page.finalUrl);
        if (!this.cache.has(finalKey)) this.cache.set(finalKey, Promise.resolve(outcome));
        return outcome;
      },
      (error): FetchOutcome => ({ ok: false, url, reason: describeEgressError(error) }),
    );
    this.cache.set(key, pending);
    // An aborted fetch should not poison the cache for a later, uncancelled attempt.
    void pending.then((o) => {
      if (!o.ok && o.reason === "cancelled" && this.cache.get(key) === pending) this.cache.delete(key);
    });
    return pending;
  }
}

function cacheKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Budget

export interface ResearchCaps {
  steps: number;
  searches: number;
  fetches: number;
  wallMs: number;
}

export const RESEARCH_CAPS: ResearchCaps = { steps: 12, searches: 6, fetches: 12, wallMs: 60_000 };

/**
 * Caps for a plan with this many study hours in all: a week of evenings needs a handful of materials and little
 * searching, half a year of full-time study needs more of both.
 */
export function capsFor(totalHours: number): ResearchCaps {
  if (totalHours <= 10) return { steps: 8, searches: 3, fetches: 6, wallMs: 45_000 };
  if (totalHours <= 40) return { steps: 10, searches: 5, fetches: 10, wallMs: 60_000 };
  if (totalHours <= 100) return RESEARCH_CAPS;
  return { steps: 14, searches: 8, fetches: 16, wallMs: 90_000 };
}

/** Counts tool calls against the caps. A call past its cap is refused here, whatever the model asked for. */
export class ResearchBudget {
  searches = 0;
  fetches = 0;
  private readonly startedAt: number;
  constructor(
    readonly caps: ResearchCaps = RESEARCH_CAPS,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.startedAt = clock();
  }

  take(kind: "search" | "fetch"): boolean {
    if (this.expired()) return false;
    if (kind === "search") {
      if (this.searches >= this.caps.searches) return false;
      this.searches += 1;
    } else {
      if (this.fetches >= this.caps.fetches) return false;
      this.fetches += 1;
    }
    return true;
  }

  elapsedMs(): number {
    return this.clock() - this.startedAt;
  }

  expired(): boolean {
    return this.elapsedMs() >= this.caps.wallMs;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Notes: what the loop saw, for the final structured step and for the gate

export interface SearchNote {
  query: string;
  results: SearchResult[];
}

export interface FetchNote {
  url: string;
  ok: boolean;
  title: string | null;
  finalUrl: string | null;
  reason?: string;
  excerpt: string;
  /** The page's length, when the read measured it. */
  words?: number | null;
  durationMinutes?: number | null;
}

export class ResearchNotes {
  readonly searches: SearchNote[] = [];
  readonly fetches: FetchNote[] = [];
  /** Things the model wrote between tool calls. */
  readonly remarks: string[] = [];

  /** Every URL that appeared in a search result or was read, so `recommendedBy` can be checked against it. */
  seenUrls(): Set<string> {
    const seen = new Set<string>();
    for (const s of this.searches) for (const r of s.results) seen.add(cacheKey(r.url));
    for (const f of this.fetches) {
      if (!f.ok) continue;
      seen.add(cacheKey(f.url));
      if (f.finalUrl) seen.add(cacheKey(f.finalUrl));
    }
    return seen;
  }

  /** A compact rendering for the final step's prompt. */
  render(): string {
    const parts: string[] = [];
    for (const s of this.searches) {
      parts.push(`Search: "${s.query}"`);
      for (const r of s.results) parts.push(`  - ${r.title} <${r.url}>${r.publishedDate ? ` (${r.publishedDate})` : ""}: ${r.snippet.slice(0, 240)}`);
      if (s.results.length === 0) parts.push(`  (no results)`);
    }
    for (const f of this.fetches) {
      if (f.ok) {
        const size = f.durationMinutes ? ` (runtime ${f.durationMinutes} min)` : f.words ? ` (${f.words} words)` : "";
        parts.push(`Read <${f.url}>${f.finalUrl && f.finalUrl !== f.url ? ` → <${f.finalUrl}>` : ""}: title "${f.title ?? "(none)"}"${size}\n  ${f.excerpt}`);
      }
      else parts.push(`Could not read <${f.url}>: ${f.reason}`);
    }
    if (this.remarks.length > 0) parts.push(`Your notes while researching:\n${this.remarks.join("\n")}`);
    return parts.join("\n");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The two tools

export interface ResearchToolsOptions {
  provider: SearchProvider;
  fetcher: SourceFetcher;
  budget: ResearchBudget;
  notes: ResearchNotes;
  emit: (event: ResearchEvent) => void;
  /** Called when the search API fails; the loop ends early and drafts from what it has. */
  onSearchError: (error: Error) => void;
}

export const BUDGET_SPENT = "budget spent";

export function createResearchTools(opts: ResearchToolsOptions) {
  const { provider, fetcher, budget, notes, emit } = opts;

  const webSearch = tool({
    description: `Search the web. Returns up to ${SEARCH_RESULTS} results as title, url, snippet and published date — never the page itself. Use fetchSource to read a page.`,
    inputSchema: z.object({ query: z.string().min(1).max(200).describe("A focused search query") }),
    execute: async ({ query }, { abortSignal }) => {
      if (!budget.take("search")) return { error: `${BUDGET_SPENT}: no searches left. Work with what you have.` };
      try {
        const results = await provider.search(query, { signal: abortSignal, maxResults: SEARCH_RESULTS });
        notes.searches.push({ query, results });
        emit({ type: "research.search", query, results: results.length });
        return { results };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        opts.onSearchError(err);
        return { error: "Search is unavailable. Stop and summarize what you have." };
      }
    },
  });

  const fetchSource = tool({
    description:
      "Read one page (https only). Returns the page's own title, og:title, first heading, author, published date and about 4k tokens of readable text. Some sites refuse; that is fine, move on.",
    inputSchema: z.object({ url: z.string().min(1).max(2000).describe("The page to read, as an https URL") }),
    execute: async ({ url }, { abortSignal }) => {
      if (!budget.take("fetch")) return { error: `${BUDGET_SPENT}: no page reads left. Work with what you have.` };
      emit({ type: "research.reading", url });
      const outcome = await fetcher.fetch(url, abortSignal);
      if (!outcome.ok) {
        notes.fetches.push({ url, ok: false, title: null, finalUrl: null, reason: outcome.reason, excerpt: "" });
        emit({ type: "research.fetch", url, ok: false, reason: outcome.reason });
        return { error: `Could not read the page: ${outcome.reason}` };
      }
      const { page } = outcome;
      notes.fetches.push({
        url,
        ok: true,
        title: page.ogTitle ?? page.title ?? page.h1,
        finalUrl: page.finalUrl,
        excerpt: page.text.slice(0, 400).replace(/\s+/g, " "),
        words: page.words ?? null,
        durationMinutes: page.durationMinutes ?? null,
      });
      emit({ type: "research.fetch", url, ok: true });
      return page;
    },
  });

  return { webSearch, fetchSource };
}
