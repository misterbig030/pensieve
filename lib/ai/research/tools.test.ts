import { describe, expect, it, vi } from "vitest";
import { extractHtml, extractPdf, htmlToText } from "./extract";
import type { ResearchEvent } from "./events";
import {
  ResearchBudget,
  ResearchNotes,
  SourceFetcher,
  createResearchTools,
  createTavilyProvider,
  type PageFetcher,
  type SearchProvider,
} from "./tools";
import { EgressError } from "./egress";
import type { PageInfo } from "./extract";

const page = (url: string, title: string): PageInfo => ({
  finalUrl: url,
  title,
  ogTitle: null,
  h1: null,
  author: null,
  published: null,
  text: `About ${title}`,
});

const execOpts = { toolCallId: "t", messages: [], context: {} } as never;

describe("extractHtml", () => {
  it("reads title, og:title, h1, author, date and readable text", () => {
    const html = `<!doctype html><html><head>
      <title>AI Engineering &amp; You | O&#39;Reilly</title>
      <meta property="og:title" content="AI Engineering">
      <meta name="author" content="Chip Huyen">
      <meta property="article:published_time" content="2025-01-07">
      <script>var x = "<h1>not this</h1>";</script>
    </head><body><nav>Menu</nav><h1>AI <em>Engineering</em></h1><p>Building applications</p><p>with foundation models.</p></body></html>`;
    const info = extractHtml(html, "https://example.com/book");
    expect(info.title).toBe("AI Engineering & You | O'Reilly");
    expect(info.ogTitle).toBe("AI Engineering");
    expect(info.h1).toBe("AI Engineering");
    expect(info.author).toBe("Chip Huyen");
    expect(info.published).toBe("2025-01-07");
    expect(info.text).toContain("Building applications");
    expect(info.text).not.toContain("Menu");
    expect(info.text).not.toContain("not this");
  });

  it("falls back to citation_title for papers", () => {
    const info = extractHtml(`<meta name="citation_title" content="Attention Is All You Need">`, "https://arxiv.org/abs/1706.03762");
    expect(info.ogTitle).toBe("Attention Is All You Need");
  });

  it("caps the text at about 4k tokens", () => {
    expect(htmlToText(`<p>${"word ".repeat(10_000)}</p>`).length).toBeLessThanOrEqual(16_000);
  });
});

describe("extractPdf", () => {
  it("reads the document-info title", () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Title (Deep Learning \\(2nd ed.\\)) /Author (Goodfellow) >> endobj");
    const info = extractPdf(pdf, "https://example.com/a.pdf");
    expect(info.title).toBe("Deep Learning (2nd ed.)");
    expect(info.author).toBe("Goodfellow");
  });
});

describe("createTavilyProvider", () => {
  it("posts the query and maps results", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ results: [{ title: "A", url: "https://a.example/", content: "snippet", published_date: "2025-03-01" }] }),
    );
    const provider = createTavilyProvider("tvly-key", fetchImpl as unknown as typeof fetch);
    const results = await provider.search("best llm book", { maxResults: 5 });
    expect(results).toEqual([{ title: "A", url: "https://a.example/", snippet: "snippet", publishedDate: "2025-03-01" }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/search");
    expect(JSON.parse(init.body as string)).toMatchObject({ query: "best llm book", max_results: 5 });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tvly-key");
  });

  it("throws on an error status", async () => {
    const provider = createTavilyProvider("k", (async () => new Response("no", { status: 429 })) as unknown as typeof fetch);
    await expect(provider.search("q", { maxResults: 5 })).rejects.toThrow(/429/);
  });
});

describe("SourceFetcher", () => {
  it("caches outcomes by requested and final URL", async () => {
    const fetchPage = vi.fn<PageFetcher>(async (url) => page(url === "https://a.example/old" ? "https://a.example/new" : url, "A"));
    const fetcher = new SourceFetcher(fetchPage);
    const first = await fetcher.fetch("https://a.example/old");
    expect(first.ok).toBe(true);
    await fetcher.fetch("https://a.example/old#section");
    await fetcher.fetch("https://a.example/new");
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("turns guard errors into a readable reason", async () => {
    const fetcher = new SourceFetcher(async () => {
      throw new EgressError("status", "HTTP 404");
    });
    expect(await fetcher.fetch("https://a.example/")).toEqual({ ok: false, url: "https://a.example/", reason: "returned 404" });
  });
});

describe("ResearchBudget", () => {
  it("refuses calls past each cap and after the clock runs out", () => {
    let now = 0;
    const budget = new ResearchBudget({ steps: 12, searches: 2, fetches: 1, wallMs: 1000 }, () => now);
    expect(budget.take("search")).toBe(true);
    expect(budget.take("search")).toBe(true);
    expect(budget.take("search")).toBe(false);
    expect(budget.take("fetch")).toBe(true);
    expect(budget.take("fetch")).toBe(false);
    const late = new ResearchBudget({ steps: 12, searches: 6, fetches: 12, wallMs: 1000 }, () => now);
    now = 1000;
    expect(late.take("search")).toBe(false);
  });
});

describe("research tools", () => {
  function setup(caps = { steps: 12, searches: 1, fetches: 1, wallMs: 60_000 }) {
    const events: ResearchEvent[] = [];
    const provider: SearchProvider = {
      name: "fake",
      search: vi.fn(async (q: string) => [{ title: `R for ${q}`, url: "https://r.example/", snippet: "s", publishedDate: null }]),
    };
    const fetchPage = vi.fn<PageFetcher>(async (url) => page(url, "Page"));
    const notes = new ResearchNotes();
    const onSearchError = vi.fn();
    const tools = createResearchTools({
      provider,
      fetcher: new SourceFetcher(fetchPage),
      budget: new ResearchBudget(caps),
      notes,
      emit: (e) => events.push(e),
      onSearchError,
    });
    return { tools, events, provider, fetchPage, notes, onSearchError };
  }

  it("enforces the search cap in code whatever the model asks for", async () => {
    const { tools, provider, events } = setup();
    await tools.webSearch.execute!({ query: "one" }, execOpts);
    const second = await tools.webSearch.execute!({ query: "two" }, execOpts);
    expect(second).toMatchObject({ error: expect.stringMatching(/budget spent/) });
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: "research.search", query: "one", results: 1 }]);
  });

  it("enforces the fetch cap and emits reading then fetch", async () => {
    const { tools, fetchPage, events, notes } = setup();
    const first = await tools.fetchSource.execute!({ url: "https://a.example/" }, execOpts);
    expect(first).toMatchObject({ title: "Page" });
    const second = await tools.fetchSource.execute!({ url: "https://b.example/" }, execOpts);
    expect(second).toMatchObject({ error: expect.stringMatching(/budget spent/) });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toEqual(["research.reading", "research.fetch"]);
    expect(notes.seenUrls().has("https://a.example/")).toBe(true);
  });

  it("reports a search failure so the loop can stop early", async () => {
    const { tools, provider, onSearchError } = setup();
    vi.mocked(provider.search).mockRejectedValueOnce(new Error("503"));
    const result = await tools.webSearch.execute!({ query: "q" }, execOpts);
    expect(result).toMatchObject({ error: expect.stringMatching(/unavailable/) });
    expect(onSearchError).toHaveBeenCalledOnce();
  });
});
