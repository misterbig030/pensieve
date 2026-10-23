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
import { SAMPLE_RECORDS } from "./dataFile";
import {
  ITEM_FILE_BYTES,
  ITEM_FINDER_WALL_MS,
  ITEM_FULL_READ_MS,
  ITEM_GATHER_MS,
  ITEM_LOCATE_MS,
  ITEM_MAP_MS,
  createItemFinder,
  guardedFullReader,
  itemListFacts,
  listGroups,
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

const MAPPING = {
  found: true,
  path: "",
  title: "problem",
  number: null,
  group: "pattern",
  difficulty: "difficulty",
  minutes: null,
  url: "https://leetcode.com/problems/{link}",
  solutionUrl: "https://www.youtube.com/watch?v={video}",
  subset: null,
};
const fileRead = (text: string) => vi.fn<FullReader>(async (url) => ({ finalUrl: url, text, file: true, truncated: false }));
const run = (model: MockLanguageModelV4, read: FullReader, fetched: Record<string, PageInfo> = pages) => {
  const { fetcher, fetchPage } = fetcherFor(fetched);
  const events: ResearchEvent[] = [];
  const p = provider();
  return { p, fetchPage, events, found: createItemFinder({ provider: p, model, read }).find(source, { fetcher, emit: (e) => void events.push(e) }) };
};
const promptOf = (model: MockLanguageModelV4, call: number) => JSON.stringify(model.doGenerateCalls[call].prompt);

describe("the item-list finder", () => {
  it("returns the subset the source names", async () => {
    const flagged = ENTRIES.filter((e) => e.neetcode150);
    // The model only says where the file is and how its fields map; code picks the subset and copies every field.
    const model = answers({ list: null, read: [RAW_URL] }, { ...MAPPING, subset: { field: "neetcode150", equals: "true" } });
    const read = fileRead(FIXTURE);
    const { p, fetchPage, events, found } = run(model, read);
    const result = await found;

    expect(p.search).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([SOURCE_URL, REPO_URL]);
    expect(read.mock.calls.map((c) => c[0])).toEqual([RAW_URL]);
    expect(result.counts).toEqual({ searches: 2, fetches: 3 });
    expect(model.doGenerateCalls).toHaveLength(2);
    const where = promptOf(model, 0);
    expect(where).toContain("NeetCode 150");
    expect(where).toContain(source.why!);
    expect(where).toContain(`--- ${REPO_URL} ---`);
    const mapping = promptOf(model, 1);
    expect(mapping).toContain("Fields: problem, pattern, link, video, difficulty, code, neetcode150, blind75");
    expect(mapping).toContain("leetcode.com/problems/two-sum/"); // the repo page, where the link pattern shows

    const list = result.list!;
    expect(list).toMatchObject({ source: "file", url: RAW_URL });
    expect(list.items.map((i) => i.title)).toEqual(flagged.map((e) => e.problem));
    expect(listGroups(list)).toEqual(["Arrays & Hashing", "Two Pointers", "Sliding Window"]);
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

  it("maps a CSV file, quoted fields and all", async () => {
    const csv = [
      "Title,Topic,Level,Slug",
      '"Two Sum, Sorted",Arrays,Medium,two-sum-ii',
      "Valid Anagram,Arrays,Easy,valid-anagram",
      'Group Anagrams,"Arrays, Hashing",Medium,group-anagrams',
      "Climbing Stairs,DP,Easy,climbing-stairs",
    ].join("\r\n");
    const model = answers(
      { list: null, read: ["https://files.example.org/list.csv"] },
      { ...MAPPING, path: null, title: "Title", group: "Topic", difficulty: "Level", url: "https://leetcode.com/problems/{Slug}/", solutionUrl: null },
    );
    const list = (await run(model, fileRead(csv)).found).list!;
    expect(list.source).toBe("file");
    expect(list.items.map((i) => [i.title, i.group, i.difficulty, i.url])).toEqual([
      ["Two Sum, Sorted", "Arrays", "medium", "https://leetcode.com/problems/two-sum-ii/"],
      ["Valid Anagram", "Arrays", "easy", "https://leetcode.com/problems/valid-anagram/"],
      ["Group Anagrams", "Arrays, Hashing", "medium", "https://leetcode.com/problems/group-anagrams/"],
      ["Climbing Stairs", "DP", "easy", "https://leetcode.com/problems/climbing-stairs/"],
    ]);
    expect(promptOf(model, 1)).toContain("CSV rows: 4");
  });

  it("maps records nested in their groups, the group taken from the object they sit in", async () => {
    const nested = JSON.stringify({
      title: "Practice",
      groups: [
        { name: "Arrays", problems: [{ name: "Two Sum" }, { name: "Valid Anagram" }] },
        { name: "Trees", problems: [{ name: "Invert Binary Tree" }, { name: "Same Tree" }] },
      ],
    });
    const model = answers({ list: null, read: [RAW_URL] }, { ...MAPPING, path: "groups[].problems", title: "name", group: "../name", difficulty: null, url: null, solutionUrl: null });
    const list = (await run(model, fileRead(nested)).found).list!;
    expect(list.items.map((i) => [i.title, i.group])).toEqual([
      ["Two Sum", "Arrays"],
      ["Valid Anagram", "Arrays"],
      ["Invert Binary Tree", "Trees"],
      ["Same Tree", "Trees"],
    ]);
    expect(promptOf(model, 1)).toContain('Records at path \\"groups[].problems\\": 4');
  });

  it("shows the model a sample of a large file and lists every record from code", async () => {
    const big = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ problem: `Problem number ${i + 1}`, pattern: `Group ${Math.floor(i / 30)}` })));
    const model = answers({ list: null, read: [RAW_URL] }, { ...MAPPING, difficulty: null, url: null, solutionUrl: null });
    const list = (await run(model, fileRead(big)).found).list!;
    expect(list.items).toHaveLength(300);
    expect(list.items.at(-1)!.title).toBe("Problem number 300");
    const prompt = promptOf(model, 1);
    expect(prompt).toContain(`Problem number ${SAMPLE_RECORDS}`);
    expect(prompt).not.toContain(`Problem number ${SAMPLE_RECORDS + 1}`);
    expect(prompt.length).toBeLessThan(big.length);
  });

  it("works by count when the mapping names nothing the file has, without transcribing the file", async () => {
    const wrongPath = answers({ list: null, read: [RAW_URL] }, { ...MAPPING, path: "nowhere" });
    expect((await run(wrongPath, fileRead(FIXTURE)).found).list).toBeNull();
    expect(wrongPath.doGenerateCalls).toHaveLength(2);
    const noFlag = answers({ list: null, read: [RAW_URL] }, { ...MAPPING, subset: { field: "neetcode300", equals: "true" } });
    expect((await run(noFlag, fileRead(FIXTURE)).found).list).toBeNull();
    expect(noFlag.doGenerateCalls).toHaveLength(2);
  });

  it("transcribes a page that lists the items when there is no data file", async () => {
    const listing = { ...pages, [REPO_URL]: info(REPO_URL, "Problems", "The list: Two Sum. Valid Anagram. Group Anagrams. See https://leetcode.com/problems/two-sum/") };
    const items = [draft("Two Sum", { url: "https://leetcode.com/problems/two-sum/" }), draft("Valid Anagram"), draft("Group Anagrams")];
    const model = answers({ list: REPO_URL, read: [] }, { found: true, url: `${REPO_URL}/`, items });
    const read = vi.fn<FullReader>();
    const result = await run(model, read, listing).found;
    expect(result.list).toMatchObject({ source: "page", url: REPO_URL });
    expect(result.list!.items.map((i) => i.title)).toEqual(["Two Sum", "Valid Anagram", "Group Anagrams"]);
    expect(read).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("discards a transcribed list from a page it never read", async () => {
    const model = answers({ list: REPO_URL, read: [] }, { found: true, url: "https://elsewhere.example.com/list", items: [draft("A"), draft("B"), draft("C")] });
    expect((await run(model, vi.fn<FullReader>()).found).list).toBeNull();
  });

  it("drops links to hosts it never read", () => {
    const readText = "Two Sum. Valid Anagram. Group Anagrams. Problems link to https://leetcode.com/problems/<slug>/";
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
    const text = (items: ItemDraft[]) => items.map((i) => i.title).join("\n");
    expect(validateItemList(raw(n(2)), text(n(2)))).toBeNull();
    expect(validateItemList(raw(n(501)), text(n(501)))).toBeNull();
    expect(validateItemList(raw(n(3)), text(n(3)))!.items).toHaveLength(3);
    expect(validateItemList(raw(n(500)), text(n(500)))!.items).toHaveLength(500);
    // Blank titles and a title repeated within its group do not count toward the three.
    expect(validateItemList(raw([draft("A", { group: "G" }), draft(" a ", { group: "G" }), draft("  "), draft("B")]), "A B")).toBeNull();
    const again = validateItemList(raw([draft("A", { group: "G" }), draft("A", { group: "H" }), draft("A", { group: "G" }), draft("B", { group: "G" })]), "A B")!;
    expect(again.items.map((i) => [i.title, i.group])).toEqual([
      ["A", "G"],
      ["A", "H"],
      ["B", "G"],
    ]);
    expect(validateItemList({ ...raw(n(3)), url: "http://example.com/list" }, text(n(3)))).toBeNull();
  });

  it("drops an item it never read, and refuses a list with more than a tenth of them made up", () => {
    const ten = Array.from({ length: 10 }, (_, i) => draft(`Problem ${String.fromCharCode(65 + i)}`));
    const raw = { url: RAW_URL, source: "page" as const, items: ten };
    const shown = (count: number) => ten.slice(0, count).map((i) => i.title.toUpperCase()).join(" · ");
    const nine = validateItemList(raw, shown(9))!;
    expect(nine.items.map((i) => i.title)).toEqual(ten.slice(0, 9).map((i) => i.title));
    expect(validateItemList(raw, shown(8))).toBeNull();
    // A title must appear whole: "Problem A" is not read in "Problem AB".
    expect(validateItemList({ ...raw, items: ten.slice(0, 3) }, "Problem AB Problem BC Problem CD")).toBeNull();
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
      "A B C",
    )!;
    expect(list.items.map((i) => [i.number, i.difficulty, i.minutes])).toEqual([
      ["49", "medium", 20],
      [null, null, null],
      [null, "hard", null],
    ]);
  });

  it("still reads the source's own page when search is down, and calls no model when nothing opens", async () => {
    const down = {
      name: "fake",
      search: vi.fn<SearchProvider["search"]>(async () => {
        throw new SearchProviderError("down");
      }),
    };
    const model = answers({ list: null, read: [] });
    const { fetcher, fetchPage } = fetcherFor(pages);
    const found = await createItemFinder({ provider: down, model, read: vi.fn<FullReader>() }).find(source, { fetcher, emit: () => {} });
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([SOURCE_URL]);
    expect(found.list).toBeNull();
    expect(model.doGenerateCalls).toHaveLength(1);

    const silent = answers({ list: null, read: [] });
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
    const list = validateItemList({ url: RAW_URL, source: "file", items: [draft("A", { group: "G" }), draft("B", { group: "G" }), draft("C", { group: "H" })] }, "A B C")!;
    expect(itemListFacts(list, 3)).toEqual(["3 items", "2 groups", RAW_URL]);
    expect(itemListFacts(list, 150)).toEqual(["3 items", "2 groups", RAW_URL, "found 3 items; research said 150"]);
    expect(itemListFacts(null, 150)).toEqual(["no item list"]);
  });

  it("keeps the data-file path within the brief's wall, each stage on its own clock", () => {
    expect(ITEM_FINDER_WALL_MS).toBe(ITEM_GATHER_MS + ITEM_LOCATE_MS + ITEM_FULL_READ_MS + ITEM_MAP_MS);
    expect(ITEM_FINDER_WALL_MS).toBeLessThanOrEqual(45_000);
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
