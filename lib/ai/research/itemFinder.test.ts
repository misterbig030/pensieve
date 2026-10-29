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
  githubRawUrl,
  guardedFullReader,
  ITEM_FULL_PAGE_CHARS,
  itemListFacts,
  listGroups,
  normalText,
  readItemListAt,
  validateItemList,
  type FullReader,
  type ItemDraft,
} from "./itemFinder";
import { SourceFetcher, type PageFetcher } from "./tools";

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
/** The repository page, already read, sits beside the read as context: it is where the link patterns show. */
const repoPage = { url: REPO_URL, finalUrl: REPO_URL, text: pages[REPO_URL].text };
const run = (model: MockLanguageModelV4, read: FullReader, url = RAW_URL, log?: { keyOwner: "user" | "app" }) => {
  const events: ResearchEvent[] = [];
  return { events, found: readItemListAt(source, url, { fetcher: fetcherFor({}).fetcher, emit: (e) => void events.push(e), log }, { model, read, pages: [repoPage] }) };
};
const promptOf = (model: MockLanguageModelV4, call: number) => JSON.stringify(model.doGenerateCalls[call].prompt);

describe("item lists", () => {
  it("returns the subset the source names", async () => {
    const flagged = ENTRIES.filter((e) => e.neetcode150);
    // The model only says how the file's fields map; code picks the subset and copies every field.
    const model = answers({ ...MAPPING, subset: { field: "neetcode150", equals: "true" } });
    const read = fileRead(FIXTURE);
    const { events, found } = run(model, read);
    const result = await found;

    expect(read.mock.calls.map((c) => c[0])).toEqual([RAW_URL]);
    expect(result.counts).toEqual({ searches: 0, fetches: 1 });
    expect(model.doGenerateCalls).toHaveLength(1);
    const mapping = promptOf(model, 0);
    expect(mapping).toContain("NeetCode 150");
    expect(mapping).toContain(source.why!);
    expect(mapping).toContain(`--- ${REPO_URL} ---`);
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
    expect(events.filter((e) => e.type === "research.fetch").map((e) => (e as { url: string }).url)).toEqual([RAW_URL]);
  });

  it("takes an item's number from the start of a code field (0049-group-anagrams is 49)", async () => {
    const model = answers({ ...MAPPING, number: "code", subset: { field: "neetcode150", equals: "true" } });
    const result = await run(model, fileRead(FIXTURE)).found;
    const items = result.list!.items;
    expect(items.find((i) => i.title === "Group Anagrams")!.number).toBe("49");
    expect(items.find((i) => i.title === "Contains Duplicate")!.number).toBe("217");
    expect(items.every((i) => i.number !== null && /^[1-9]\d*$/.test(i.number))).toBe(true);
  });

  it("maps a CSV file, quoted fields and all", async () => {
    const csv = [
      "Title,Topic,Level,Slug",
      '"Two Sum, Sorted",Arrays,Medium,two-sum-ii',
      "Valid Anagram,Arrays,Easy,valid-anagram",
      'Group Anagrams,"Arrays, Hashing",Medium,group-anagrams',
      "Climbing Stairs,DP,Easy,climbing-stairs",
    ].join("\r\n");
    const model = answers({ ...MAPPING, path: null, title: "Title", group: "Topic", difficulty: "Level", url: "https://leetcode.com/problems/{Slug}/", solutionUrl: null });
    const list = (await run(model, fileRead(csv), "https://files.example.org/list.csv").found).list!;
    expect(list.source).toBe("file");
    expect(list.items.map((i) => [i.title, i.group, i.difficulty, i.url])).toEqual([
      ["Two Sum, Sorted", "Arrays", "medium", "https://leetcode.com/problems/two-sum-ii/"],
      ["Valid Anagram", "Arrays", "easy", "https://leetcode.com/problems/valid-anagram/"],
      ["Group Anagrams", "Arrays, Hashing", "medium", "https://leetcode.com/problems/group-anagrams/"],
      ["Climbing Stairs", "DP", "easy", "https://leetcode.com/problems/climbing-stairs/"],
    ]);
    expect(promptOf(model, 0)).toContain("CSV rows: 4");
  });

  it("maps records nested in their groups, the group taken from the object they sit in", async () => {
    const nested = JSON.stringify({
      title: "Practice",
      groups: [
        { name: "Arrays", problems: [{ name: "Two Sum" }, { name: "Valid Anagram" }] },
        { name: "Trees", problems: [{ name: "Invert Binary Tree" }, { name: "Same Tree" }] },
      ],
    });
    const model = answers({ ...MAPPING, path: "groups[].problems", title: "name", group: "../name", difficulty: null, url: null, solutionUrl: null });
    const list = (await run(model, fileRead(nested)).found).list!;
    expect(list.items.map((i) => [i.title, i.group])).toEqual([
      ["Two Sum", "Arrays"],
      ["Valid Anagram", "Arrays"],
      ["Invert Binary Tree", "Trees"],
      ["Same Tree", "Trees"],
    ]);
    expect(promptOf(model, 0)).toContain('Records at path \\"groups[].problems\\": 4');
  });

  it("shows the model a sample of a large file and lists every record from code", async () => {
    const big = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ problem: `Problem number ${i + 1}`, pattern: `Group ${Math.floor(i / 30)}` })));
    const model = answers({ ...MAPPING, difficulty: null, url: null, solutionUrl: null });
    const list = (await run(model, fileRead(big)).found).list!;
    expect(list.items).toHaveLength(300);
    expect(list.items.at(-1)!.title).toBe("Problem number 300");
    const prompt = promptOf(model, 0);
    expect(prompt).toContain(`Problem number ${SAMPLE_RECORDS}`);
    expect(prompt).not.toContain(`Problem number ${SAMPLE_RECORDS + 1}`);
    expect(prompt.length).toBeLessThan(big.length);
  });

  it("works by count when the mapping names nothing the file has, without transcribing the file", async () => {
    const wrongPath = answers({ ...MAPPING, path: "nowhere" });
    expect((await run(wrongPath, fileRead(FIXTURE)).found).list).toBeNull();
    expect(wrongPath.doGenerateCalls).toHaveLength(1);
    const noFlag = answers({ ...MAPPING, subset: { field: "neetcode300", equals: "true" } });
    expect((await run(noFlag, fileRead(FIXTURE)).found).list).toBeNull();
    expect(noFlag.doGenerateCalls).toHaveLength(1);
  });

  it("discards a transcribed list from a page it never read", async () => {
    const model = answers({ found: true, url: "https://elsewhere.example.com/list", items: [draft("A"), draft("B"), draft("C")] });
    expect((await run(model, vi.fn<FullReader>(), REPO_URL).found).list).toBeNull();
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

  it("keeps a number only as a short label, or the leading number of a longer code", () => {
    const numbers = ["0049", "Q12", "1.2", "#7", "12a", "0049-group-anagrams", "128_longest-consecutive", "group-anagrams", "Arrays and hashing", "1234567890-x", "0"];
    const list = validateItemList({ url: RAW_URL, source: "file", items: numbers.map((number, i) => draft(`Problem ${i + 1}`, { number })) }, numbers.map((_, i) => `Problem ${i + 1}`).join(" · "))!;
    expect(list.items.map((i) => i.number)).toEqual(["49", "Q12", "1.2", "7", "12a", "49", "128", null, null, null, null]);
  });

  it("rethrows a provider refusal on the user's key and swallows one on the app's", async () => {
    const refusing = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "Your credit balance is too low", isRetryable: false });
      },
    });
    // The repository page, already read, is transcribed: one model call, refused.
    await expect(run(refusing, vi.fn<FullReader>(), REPO_URL, { keyOwner: "user" }).found).rejects.toSatisfy((e: unknown) => providerError(e)?.statusCode === 400);
    expect((await run(refusing, vi.fn<FullReader>(), REPO_URL, { keyOwner: "app" }).found).list).toBeNull();
  });

  it("states the list's size, groups and page, and a count far from what research said", () => {
    const list = validateItemList({ url: RAW_URL, source: "file", items: [draft("A", { group: "G" }), draft("B", { group: "G" }), draft("C", { group: "H" })] }, "A B C")!;
    expect(itemListFacts(list, 3)).toEqual(["3 items", "2 groups", RAW_URL]);
    expect(itemListFacts(list, 150)).toEqual(["3 items", "2 groups", RAW_URL, "found 3 items; research said 150"]);
    expect(itemListFacts(null, 150)).toEqual(["no item list"]);
  });
});

describe("reading the item list at a given address", () => {
  const ctx = () => {
    const events: ResearchEvent[] = [];
    return { events, ctx: { fetcher: fetcherFor({}).fetcher, emit: (e: ResearchEvent) => void events.push(e) } };
  };

  it("maps a data file read in full: the whole fixture, from code, with no search and no other page", async () => {
    const model = answers(MAPPING);
    const read = fileRead(FIXTURE);
    const { events, ctx: c } = ctx();
    const result = await readItemListAt(source, RAW_URL, c, { model, read });

    expect(read.mock.calls.map((call) => call[0])).toEqual([RAW_URL]);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(result.counts).toEqual({ searches: 0, fetches: 1 });
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
    expect(result.list).toMatchObject({ source: "file", url: RAW_URL });
    expect(result.list!.items).toHaveLength(ENTRIES.length);
    expect(result.pages).toEqual([{ url: RAW_URL, finalUrl: RAW_URL, text: FIXTURE }]);
    expect(promptOf(model, 0)).toContain("Fields: problem, pattern, link, video, difficulty, code, neetcode150, blind75");
    expect(events.map((e) => e.type)).toEqual(["research.reading", "research.fetch"]);
  });

  it("reads a GitHub file page as its raw file, so a data file is mapped whole and not cut as a page", async () => {
    // GitHub's page for a file is HTML: read as a page it is cut at the page size (30 of NeetCode's 150 in a live check).
    const BLOB_URL = "https://github.com/neetcode-gh/leetcode/blob/main/.problemSiteData.json";
    const model = answers(MAPPING);
    const read = fileRead(FIXTURE);
    const result = await readItemListAt(source, BLOB_URL, ctx().ctx, { model, read });

    expect(read.mock.calls.map((call) => call[0])).toEqual([RAW_URL]);
    expect(result.list).toMatchObject({ source: "file", url: RAW_URL });
    expect(result.list!.items).toHaveLength(ENTRIES.length);
  });

  it("transcribes a page that is not a data file, that page the only read", async () => {
    const text = "The list: Two Sum. Valid Anagram. Group Anagrams.";
    const model = answers({ found: true, url: REPO_URL, items: [draft("Two Sum"), draft("Valid Anagram"), draft("Group Anagrams")] });
    const read = vi.fn<FullReader>(async (url) => ({ finalUrl: url, text, file: false, truncated: false }));
    const result = await readItemListAt(source, REPO_URL, ctx().ctx, { model, read });

    expect(result.list).toMatchObject({ source: "page", url: REPO_URL });
    expect(result.list!.items.map((i) => i.title)).toEqual(["Two Sum", "Valid Anagram", "Group Anagrams"]);
    expect(result.pages).toEqual([{ url: REPO_URL, finalUrl: REPO_URL, text }]);
    expect(model.doGenerateCalls).toHaveLength(1);
    const prompt = promptOf(model, 0);
    expect(prompt.match(/--- https/g)).toHaveLength(1);
    expect(prompt).toContain(`--- ${REPO_URL} ---`);
  });

  it("caps a plain-text file that is not data at the page size before transcribing it", async () => {
    const head = "Two Sum. Valid Anagram. Group Anagrams. ";
    const text = head + "x".repeat(ITEM_FULL_PAGE_CHARS) + " TAILMARKER";
    expect(text.length).toBeGreaterThan(ITEM_FULL_PAGE_CHARS);
    const model = answers({ found: true, url: RAW_URL, items: [draft("Two Sum"), draft("Valid Anagram"), draft("Group Anagrams")] });
    const read = fileRead(text);
    const result = await readItemListAt(source, RAW_URL, ctx().ctx, { model, read });
    expect(result.list).toMatchObject({ source: "file", url: RAW_URL });
    const prompt = promptOf(model, 0);
    expect(prompt).toContain("Two Sum. Valid Anagram");
    expect(prompt).not.toContain("TAILMARKER");
    expect(prompt).toContain("cut at the size limit");
    // The read it returns is what the list was checked against: the text cut as the model saw it.
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text).toHaveLength(ITEM_FULL_PAGE_CHARS);
    expect(result.pages[0].text).not.toContain("TAILMARKER");
    expect(prompt.length).toBeLessThan(ITEM_FULL_PAGE_CHARS + 5_000);
  });

  it("returns no list when the address does not open, without calling the model", async () => {
    const model = answers(MAPPING);
    const read = vi.fn<FullReader>(async () => {
      throw new Error("404");
    });
    const { events, ctx: c } = ctx();
    const result = await readItemListAt(source, RAW_URL, c, { model, read });
    expect(result).toEqual({ list: null, counts: { searches: 0, fetches: 1 }, costUsd: 0, pages: [] });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "research.fetch", url: RAW_URL, ok: false });
  });

  it("works by count when the file is not mapped, without transcribing a data file", async () => {
    const model = answers({ ...MAPPING, path: "nowhere" });
    const result = await readItemListAt(source, RAW_URL, ctx().ctx, { model, read: fileRead(FIXTURE) });
    expect(result.list).toBeNull();
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("transcribes a page already read without reading it again, the other pages beside it as context", async () => {
    const listing = "The list: Two Sum. Valid Anagram. Group Anagrams.";
    const model = answers({ found: true, url: REPO_URL, items: [draft("Two Sum"), draft("Valid Anagram"), draft("Group Anagrams")] });
    const read = vi.fn<FullReader>();
    const given = [
      { url: SOURCE_URL, finalUrl: SOURCE_URL, text: "NeetCode" },
      { url: REPO_URL, finalUrl: REPO_URL, text: listing },
    ];
    const result = await readItemListAt(source, `${REPO_URL}/`, ctx().ctx, { model, read, pages: given });
    expect(read).not.toHaveBeenCalled();
    expect(result.counts).toEqual({ searches: 0, fetches: 0 });
    expect(result.list).toMatchObject({ source: "page", url: REPO_URL });
    expect(result.pages).toEqual(given);
    const prompt = promptOf(model, 0);
    expect(prompt).toContain(`--- ${SOURCE_URL} ---`);
    expect(prompt.match(new RegExp(`--- ${REPO_URL} ---`, "g"))).toHaveLength(1);
  });

  it("keeps the normal-text form exported", () => {
    expect(normalText("  Two-Sum, II! ")).toBe("two sum ii");
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
    expect(page.truncated).toBe(false);
  });

  it("marks a page whose readable text runs past the page cut as cut, though its bytes fit", async () => {
    const html = `<html><body><ul>${Array.from({ length: 4000 }, (_, i) => `<li>Problem number ${i} with a longer title</li>`).join("")}</ul></body></html>`;
    expect(html.length).toBeLessThan(ITEM_FILE_BYTES);
    const page = await guardedFullReader({ resolver, transport: transportFor("text/html", html) })("https://example.com/list");
    expect(page.text).toHaveLength(ITEM_FULL_PAGE_CHARS);
    expect(page.truncated).toBe(true);
  });
});

describe("githubRawUrl", () => {
  it("turns a GitHub file page into its raw file, and leaves every other address alone", () => {
    expect(githubRawUrl("https://github.com/neetcode-gh/leetcode/blob/main/.problemSiteData.json")).toBe(
      "https://raw.githubusercontent.com/neetcode-gh/leetcode/main/.problemSiteData.json",
    );
    expect(githubRawUrl("https://www.github.com/a/b/blob/v1.2/data/list.csv?plain=1#L3")).toBe("https://raw.githubusercontent.com/a/b/v1.2/data/list.csv");
    for (const same of [
      "https://github.com/neetcode-gh/leetcode",
      "https://github.com/a/b/tree/main/data",
      "https://raw.githubusercontent.com/a/b/main/list.json",
      "https://gitlab.com/a/b/blob/main/list.json",
      "https://github.com/a/b/blob/main",
      "not a url",
    ]) {
      expect(githubRawUrl(same)).toBe(same);
    }
  });
});
