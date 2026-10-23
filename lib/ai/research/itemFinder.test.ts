import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import type { Material } from "@/lib/schemas/material";
import { providerError } from "../providerError";
import type { ResolvedAddress, Transport } from "./egress";
import type { ResearchEvent } from "./events";
import type { PageInfo } from "./extract";
import {
  ITEM_FILE_BYTES,
  createItemFinder,
  guardedFullReader,
  itemListFacts,
  validateItemList,
  type FullReader,
  type ItemDraft,
} from "./itemFinder";
import { SearchProviderError, SourceFetcher, type PageFetcher, type SearchProvider } from "./tools";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "problemList.json"), "utf8");
const ENTRIES = JSON.parse(FIXTURE) as { problem: string; pattern: string; link: string; video: string; difficulty: string; neetcode150: boolean }[];

function info(url: string, title: string | null, text: string): PageInfo {
  return { finalUrl: url, title, ogTitle: null, h1: null, author: null, published: null, text };
}

function fetcherFor(pages: Record<string, PageInfo>) {
  const fetchPage = vi.fn<PageFetcher>(async (url) => {
    const p = pages[url];
    if (!p) throw new Error(`404 ${url}`);
    return p;
  });
  return { fetcher: new SourceFetcher(fetchPage), fetchPage };
}

/** A model that gives these answers in turn, one per call. */
function answers(...list: unknown[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(list[Math.min(i++, list.length - 1)]) }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
}

const draft = (title: string, extra: Partial<ItemDraft> = {}): ItemDraft => ({
  title,
  number: null,
  group: null,
  difficulty: null,
  url: null,
  solutionUrl: null,
  minutes: null,
  ...extra,
});

const SOURCE_URL = "https://neetcode.io/practice";
const REPO_URL = "https://github.com/neetcode-gh/leetcode";
const RAW_URL = "https://raw.githubusercontent.com/neetcode-gh/leetcode/main/.problemSiteData.json";

const source: Material = {
  id: "M3",
  origin: "research",
  type: "link",
  kind: "course",
  url: SOURCE_URL,
  title: "NeetCode 150",
  author: null,
  year: null,
  why: "150 LeetCode problems grouped by pattern, each with a video solution",
  backbone: false,
  verifiedAt: "2026-10-23T00:00:00.000Z",
  fetchedTitle: "NeetCode",
  recommendedBy: [],
  sig: null,
  minutes: null,
  practice: { format: "problem-set", items: 8, perItemMinutes: 10, minutes: 80, answers: true },
};

const pages: Record<string, PageInfo> = {
  [SOURCE_URL]: info(SOURCE_URL, "NeetCode", "NeetCode"),
  [REPO_URL]: info(
    REPO_URL,
    "neetcode-gh/leetcode",
    "Solutions to LeetCode problems. .problemSiteData.json lists every problem on the site. Problems: https://leetcode.com/problems/two-sum/ Videos: https://www.youtube.com/watch?v=KLlXCFG5TnA",
  ),
};

const provider = () => ({
  name: "fake",
  search: vi.fn<SearchProvider["search"]>(async () => [
    { title: "neetcode-gh/leetcode", url: REPO_URL, snippet: "", publishedDate: null },
    { title: "http", url: "http://insecure.example.com/list", snippet: "", publishedDate: null },
  ]),
});

describe("the item-list finder", () => {
  it("returns the subset the source names", async () => {
    const flagged = ENTRIES.filter((e) => e.neetcode150);
    const model = answers(
      { found: false, url: null, items: [], read: [RAW_URL] },
      {
        found: true,
        url: RAW_URL,
        read: [],
        items: flagged.map((e) =>
          draft(e.problem, {
            group: e.pattern,
            difficulty: e.difficulty,
            url: `https://leetcode.com/problems/${e.link}`,
            solutionUrl: `https://www.youtube.com/watch?v=${e.video}`,
          }),
        ),
      },
    );
    const read = vi.fn<FullReader>(async (url) => ({ finalUrl: url, text: FIXTURE, file: true, truncated: false }));
    const { fetcher, fetchPage } = fetcherFor(pages);
    const p = provider();
    const events: ResearchEvent[] = [];
    const found = await createItemFinder({ provider: p, model, read }).find(source, { fetcher, emit: (e) => void events.push(e) });

    expect(p.search).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([SOURCE_URL, REPO_URL]);
    expect(read.mock.calls.map((c) => c[0])).toEqual([RAW_URL]);
    expect(found.counts).toEqual({ searches: 2, fetches: 3 });
    expect(model.doGenerateCalls).toHaveLength(2);
    const first = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(first).toContain("NeetCode 150");
    expect(first).toContain(source.why!);
    expect(first).toContain(`--- ${REPO_URL} ---`);
    const second = JSON.stringify(model.doGenerateCalls[1].prompt);
    // The file is read in full: its last entry reaches the model.
    expect(second).toContain("minimum-window-substring/");
    expect(second).toContain("Replace Elements With Greatest Element On Right Side");

    const list = found.list!;
    expect(list).toMatchObject({ source: "file", url: RAW_URL });
    expect(list.items.map((i) => i.title)).toEqual(flagged.map((e) => e.problem));
    expect([...new Set(list.items.map((i) => i.group))]).toEqual(["Arrays & Hashing", "Two Pointers", "Sliding Window"]);
    expect(list.items[0]).toEqual({
      title: "Contains Duplicate",
      number: null,
      group: "Arrays & Hashing",
      difficulty: "easy",
      url: "https://leetcode.com/problems/contains-duplicate/",
      solutionUrl: "https://www.youtube.com/watch?v=3OamzN90kPg",
      minutes: null,
    });
    expect(list.items.at(-1)!.difficulty).toBe("hard");
    expect(events.filter((e) => e.type === "research.fetch").map((e) => (e as { url: string }).url)).toEqual([SOURCE_URL, REPO_URL, RAW_URL]);
  });

  it("drops links to hosts it never read", () => {
    const readText = "Problems link to https://leetcode.com/problems/<slug>/";
    const items = [
      draft("Two Sum", { url: "https://leetcode.com/problems/two-sum/", solutionUrl: "https://www.youtube.com/watch?v=KLlXCFG5TnA" }),
      draft("Valid Anagram", { url: "http://leetcode.com/problems/valid-anagram/" }),
      draft("Group Anagrams", { url: "not a link" }),
    ];
    const list = validateItemList({ url: RAW_URL, source: "file", items }, readText)!;
    expect(list.items.map((i) => [i.title, i.url, i.solutionUrl])).toEqual([
      ["Two Sum", "https://leetcode.com/problems/two-sum/", null],
      ["Valid Anagram", null, null],
      ["Group Anagrams", null, null],
    ]);
  });

  it("rejects a list under 3 or over 500", () => {
    const n = (count: number) => Array.from({ length: count }, (_, i) => draft(`Problem ${i + 1}`));
    const raw = (items: ItemDraft[]) => ({ url: RAW_URL, source: "file" as const, items });
    expect(validateItemList(raw(n(2)), "")).toBeNull();
    expect(validateItemList(raw(n(501)), "")).toBeNull();
    expect(validateItemList(raw(n(3)), "")!.items).toHaveLength(3);
    expect(validateItemList(raw(n(500)), "")!.items).toHaveLength(500);
    // Blank titles and a title repeated within its group do not count toward the three.
    expect(validateItemList(raw([draft("A", { group: "G" }), draft(" a ", { group: "G" }), draft("  "), draft("B")]), "")).toBeNull();
    const again = validateItemList(raw([draft("A", { group: "G" }), draft("A", { group: "H" }), draft("A", { group: "G" }), draft("B", { group: "G" })]), "")!;
    expect(again.items.map((i) => [i.title, i.group])).toEqual([
      ["A", "G"],
      ["A", "H"],
      ["B", "G"],
    ]);
    expect(validateItemList({ ...raw(n(3)), url: "http://example.com/list" }, "")).toBeNull();
  });

  it("bounds what the model wrote: numbers, difficulty labels and minutes", () => {
    const list = validateItemList(
      {
        url: RAW_URL,
        source: "page",
        items: [
          draft("A", { number: " 49 ", difficulty: "Medium", minutes: 20.4 }),
          draft("B", { number: "", difficulty: "insane", minutes: 0 }),
          draft("C", { difficulty: "HARD", minutes: 9000 }),
        ],
      },
      "",
    )!;
    expect(list.items.map((i) => [i.number, i.difficulty, i.minutes])).toEqual([
      ["49", "medium", 20],
      [null, null, null],
      [null, "hard", null],
    ]);
  });

  it("discards a list from a page it never read, and asks once when there is nothing more to read", async () => {
    const items = [draft("A"), draft("B"), draft("C")];
    const model = answers({ found: true, url: "https://elsewhere.example.com/list", items, read: [] });
    const found = await createItemFinder({ provider: provider(), model, read: vi.fn<FullReader>() }).find(source, { fetcher: fetcherFor(pages).fetcher, emit: () => {} });
    expect(found.list).toBeNull();
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("keeps a list from a page it read, without a second call", async () => {
    const items = [draft("A"), draft("B"), draft("C")];
    const model = answers({ found: true, url: `${REPO_URL}/`, items, read: [RAW_URL] });
    const read = vi.fn<FullReader>();
    const found = await createItemFinder({ provider: provider(), model, read }).find(source, { fetcher: fetcherFor(pages).fetcher, emit: () => {} });
    expect(found.list).toMatchObject({ source: "page", url: REPO_URL });
    expect(read).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("still reads the source's own page when search is down, and calls no model when nothing opens", async () => {
    const down = {
      name: "fake",
      search: vi.fn<SearchProvider["search"]>(async () => {
        throw new SearchProviderError("down");
      }),
    };
    const model = answers({ found: false, url: null, items: [], read: [] });
    const { fetcher, fetchPage } = fetcherFor(pages);
    const found = await createItemFinder({ provider: down, model, read: vi.fn<FullReader>() }).find(source, { fetcher, emit: () => {} });
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([SOURCE_URL]);
    expect(found.list).toBeNull();
    expect(model.doGenerateCalls).toHaveLength(1);

    const silent = answers({ found: false, url: null, items: [], read: [] });
    const none = await createItemFinder({ provider: down, model: silent, read: vi.fn<FullReader>() }).find(source, { fetcher: fetcherFor({}).fetcher, emit: () => {} });
    expect(none.list).toBeNull();
    expect(silent.doGenerateCalls).toHaveLength(0);
  });

  it("rethrows a provider refusal on the user's key and swallows one on the app's", async () => {
    const refusing = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "Your credit balance is too low", isRetryable: false });
      },
    });
    const ctx = { fetcher: fetcherFor(pages).fetcher, emit: () => {} };
    await expect(createItemFinder({ provider: provider(), model: refusing, read: vi.fn<FullReader>() }).find(source, { ...ctx, log: { keyOwner: "user" } })).rejects.toSatisfy(
      (e: unknown) => providerError(e)?.statusCode === 400,
    );
    expect((await createItemFinder({ provider: provider(), model: refusing, read: vi.fn<FullReader>() }).find(source, ctx)).list).toBeNull();
  });

  it("states the list's size, groups and page, and a count far from what research said", () => {
    const list = validateItemList({ url: RAW_URL, source: "file", items: [draft("A", { group: "G" }), draft("B", { group: "G" }), draft("C", { group: "H" })] }, "")!;
    expect(itemListFacts(list, 3)).toEqual(["3 items", "2 groups", RAW_URL]);
    expect(itemListFacts(list, 150)).toEqual(["3 items", "2 groups", RAW_URL, "found 3 items; research said 150"]);
    expect(itemListFacts(null, 150)).toEqual(["no item list"]);
  });
});

describe("the full reader", () => {
  const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };
  const resolver = async () => [PUBLIC];
  const transportFor = (contentType: string, text: string): Transport => async () => ({
    status: 200,
    headers: { "content-type": contentType },
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
    destroy: () => {},
  });

  it("reads a data file whole, far past the page cut, up to its own cap", async () => {
    const big = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ problem: `Problem ${i}` })));
    expect(big.length).toBeGreaterThan(16_000);
    const json = await guardedFullReader({ resolver, transport: transportFor("application/json", big) })(RAW_URL);
    expect(json).toEqual({ finalUrl: RAW_URL, text: big, file: true, truncated: false });
    const plain = await guardedFullReader({ resolver, transport: transportFor("text/plain; charset=utf-8", FIXTURE) })(RAW_URL);
    expect(plain).toMatchObject({ text: FIXTURE, file: true });
    const huge = await guardedFullReader({ resolver, transport: transportFor("text/plain", "x".repeat(ITEM_FILE_BYTES + 100)) })(RAW_URL);
    expect(huge.text).toHaveLength(ITEM_FILE_BYTES);
    expect(huge.truncated).toBe(true);
  });

  it("reads a page as its readable text, and refuses what is not text", async () => {
    const html = `<html><head><title>List</title><script>var x = 1;</script></head><body><ul>${Array.from({ length: 800 }, (_, i) => `<li>Problem number ${i}</li>`).join("")}</ul></body></html>`;
    const page = await guardedFullReader({ resolver, transport: transportFor("text/html", html) })("https://example.com/list");
    expect(page.file).toBe(false);
    expect(page.text).toContain("- Problem number 799");
    expect(page.text).not.toContain("var x");
    await expect(guardedFullReader({ resolver, transport: transportFor("application/pdf", "%PDF") })("https://example.com/a.pdf")).rejects.toThrow();
  });
});
