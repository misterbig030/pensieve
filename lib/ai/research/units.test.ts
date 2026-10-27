import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { chapterListSchema, type MaterialPractice, type PracticeList } from "@/lib/schemas/material";
import { extractHtml } from "./extract";
import { checkUnits, type SeenPage, type StructureAnswer, type StructureRole } from "./units";

function fixture(name: string): string {
  return gunzipSync(readFileSync(join(__dirname, "__fixtures__", "pages", `${name}.html.gz`))).toString("utf8");
}

/** A page as a finder tool hands it back, read from HTML the way the fetcher reads it. */
function seen(url: string, html: string, finalUrl = url): SeenPage {
  const p = extractHtml(html, finalUrl);
  return { url, finalUrl, title: p.title, words: p.words ?? null, durationMinutes: p.durationMinutes ?? null, pdfPages: null, outline: p.outline ?? null, text: p.text };
}

/** A page with no outline: a video, a PDF, a short folder page. */
function bare(url: string, over: Partial<SeenPage>): SeenPage {
  return { url, finalUrl: url, title: null, words: null, durationMinutes: null, pdfPages: null, outline: null, text: "", ...over };
}

function readme(title: string, body: string): string {
  return `<html><head><title>${title}</title></head><body><article class="markdown-body">${body}</article></body></html>`;
}

const filler = (n: number) => Array(n).fill("lorem").join(" ");
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** h2 sections as GitHub renders them: the anchor carries the `user-content-` prefix; each section is its title plus `words` filler. */
const h2s = (titles: string[], words: number) => titles.map((t) => `<h2 id="user-content-${slug(t)}">${t}</h2><p>${filler(words)}</p>`).join("");

const REPO = "https://github.com/a/b";
const PRIMER = "https://github.com/donnemartin/system-design-primer";
const PRACTICE: MaterialPractice = { format: "design-exercise", items: null, perItemMinutes: null, minutes: null, answers: true };

type Unit = StructureAnswer["units"][number];
const unit = (title: string, at: string, over: Partial<Unit> = {}): Unit => ({ title, at, kind: "read", group: null, minutes: null, ...over });
const answer = (units: Unit[], over: Partial<StructureAnswer> = {}): StructureAnswer => ({ note: "", whole: false, units, listUrl: null, ...over });

function check(opts: {
  answer: StructureAnswer;
  pages: SeenPage[];
  role?: StructureRole;
  material?: Partial<{ url: string; kind: "repo" | "book" | "course"; minutes: number | null; practice: MaterialPractice | null }>;
  lists?: PracticeList[];
}) {
  return checkUnits({
    material: { url: REPO, kind: "repo", minutes: null, minutesBasis: null, practice: null, ...opts.material },
    role: opts.role ?? "read",
    answer: opts.answer,
    pages: opts.pages,
    lists: opts.lists ?? [],
  });
}

const primerPage = seen(PRIMER, fixture("github-readme"));
const primerH2 = primerPage.outline!.headings.filter((h) => h.level === 2);
const primerUnits = () => primerH2.map((h) => unit(h.title, `${PRIMER}#${h.anchor}`));

const SECTIONS = Array.from({ length: 22 }, (_, i) => `Section ${i + 1}`);
const sectionsPage = seen(REPO, readme("a/b", h2s(SECTIONS, 100)));
const sectionUnits = () => SECTIONS.map((t) => unit(t, `${REPO}#${slug(t)}`));

/** A course README linking four week folders, and the folders: week 3's link says only "notebook". */
function hubPages(): SeenPage[] {
  const hub = seen(
    REPO,
    readme("a/b", `<h2 id="user-content-weeks">Weeks</h2><ul>
      <li><a href="/a/b/tree/main/week01">Week 1: Intro</a></li>
      <li><a href="/a/b/tree/main/week02">Week 2: Audio features and spectrograms</a></li>
      <li><a href="/a/b/tree/main/week03">notebook</a></li>
      <li><a href="/a/b/tree/main/week04">Week 4: Vocoders</a></li></ul>`),
  );
  const week = (n: number, heading: string) => seen(`${REPO}/tree/main/week0${n}`, readme(`week0${n}`, `<h1>${heading}</h1><p>${filler(100)}</p>`));
  return [hub, week(1, "Intro"), week(2, "Audio"), week(3, "Week 3: Transformers"), week(4, "Vocoders")];
}

describe("checkUnits", () => {
  it("rule 1: a whole answer, or one with no units, keeps the material whole", () => {
    const whole = { toc: null, minutes: null, basis: null, list: null, refused: null, facts: ["whole"] };
    expect(check({ answer: answer(sectionUnits(), { whole: true }), pages: [sectionsPage] })).toEqual(whole);
    expect(check({ answer: answer([]), pages: [sectionsPage] })).toEqual(whole);
  });

  it("rule 2: units of a kind the role does not have are discarded with a fact", () => {
    const units = [...sectionUnits().slice(0, 20), unit("Section 21", `${REPO}#section-21`, { kind: "practice" }), unit("Section 22", `${REPO}#section-22`, { kind: "practice" })];
    const v = check({ answer: answer(units), pages: [sectionsPage], role: "read", material: { practice: PRACTICE } });
    expect(v.refused).toBeNull();
    expect(v.toc!.chapters.map((c) => c.title)).toEqual(SECTIONS.slice(0, 20));
    expect(v.list).toBeNull();
    expect(v.facts).toContain("2 practice units discarded: the source is read only");
  });

  it("rule 2: a practice-role answer's reading units are discarded, and its practice units become a list", () => {
    const designs = primerPage.outline!.headings.filter((h) => h.level === 3 && h.title.startsWith("Design "));
    expect(designs.length).toBeGreaterThanOrEqual(3);
    const units = [...primerUnits(), ...designs.map((h) => unit(h.title, `${PRIMER}#${h.anchor}`, { kind: "practice", group: "System design" }))];
    const v = check({ answer: answer(units), pages: [primerPage], role: "practice", material: { url: PRIMER, practice: PRACTICE } });
    expect(v.refused).toBeNull();
    expect(v.toc).toBeNull();
    expect(v.minutes).toBeNull();
    expect(v.basis).toBeNull();
    expect(v.facts).toContain(`${primerH2.length} reading units discarded: the source is practice only`);
    expect(v.list!.items.length).toBeGreaterThanOrEqual(3);
    expect(v.list!.items.map((i) => i.title)).toEqual(designs.map((h) => h.title));
    expect(v.list!.items[0]).toEqual({
      title: designs[0].title,
      number: null,
      group: "System design",
      difficulty: null,
      url: `${PRIMER}#${designs[0].anchor}`,
      solutionUrl: null,
      minutes: Math.max(1, Math.round(designs[0].words / 230)),
    });
    expect(v.list!.source).toBe("page");
    expect(v.list!.url).toBe(PRIMER);
  });

  it("rule 3: #user-content-load-balancer and #Load-Balancer both match the load-balancer heading", () => {
    for (const at of [`${PRIMER}#user-content-load-balancer`, `${PRIMER}#Load-Balancer`, `${PRIMER}#load%2Dbalancer`]) {
      const units = primerUnits().map((u) => (u.title === "Load balancer" ? { ...u, at } : u));
      const v = check({ answer: answer(units), pages: [primerPage], material: { url: PRIMER } });
      expect(v.refused).toBeNull();
      const lb = v.toc!.chapters.find((c) => c.title === "Load balancer")!;
      expect(lb.url).toBe(at);
      expect(lb.minutes).toBe(Math.round(576 / 230));
    }
  });

  it("rule 4: a heading unit whose title adds words to its heading is saved under the heading's own title", () => {
    const units = primerUnits().map((u) => (u.title === "Load balancer" ? { ...u, title: "Load balancer: Kubernetes ingress" } : u));
    const v = check({ answer: answer(units), pages: [primerPage], material: { url: PRIMER } });
    expect(v.refused).toBeNull();
    expect(v.toc!.chapters.map((c) => c.title)).toEqual(primerH2.map((h) => h.title));
    expect(v.toc!.chapters.find((c) => c.url === `${PRIMER}#load-balancer`)!.title).toBe("Load balancer");
  });

  it("rule 3: a relative at is read against the source's address", () => {
    const fragments = check({ answer: answer(SECTIONS.map((t) => unit(t, `#${slug(t)}`))), pages: [sectionsPage] });
    expect(fragments.refused).toBeNull();
    expect(fragments.toc!.chapters[0].url).toBe(`${REPO}#section-1`);
    const paths = check({ answer: answer([1, 2, 3].map((n) => unit(n === 3 ? "Week 3: Transformers" : n === 2 ? "Week 2: Audio features" : "Week 1: Intro", `/a/b/tree/main/week0${n}`))), pages: hubPages() });
    expect(paths.refused).toBeNull();
    expect(paths.toc!.chapters.map((c) => c.url)).toEqual([1, 2, 3].map((n) => `${REPO}/tree/main/week0${n}`));
  });

  it("rule 3: a unit on a page no tool returned, or at an anchor the page lacks, is dropped as unseen", () => {
    const units = [...sectionUnits().slice(0, 20), unit("Section 21", `${REPO}/blob/main/notes.md`), unit("Section 22", `${REPO}#section-99`)];
    const v = check({ answer: answer(units), pages: [sectionsPage] });
    expect(v.refused).toBeNull();
    expect(v.toc!.chapters.map((c) => c.title)).toEqual(SECTIONS.slice(0, 20));
    expect(v.facts).toContain("2 of 22 units point to no fetched page or heading");
  });

  it("rule 3: a unit may point at the page's final URL after a redirect", () => {
    const page = { ...sectionsPage, url: "https://git.io/abc", finalUrl: REPO };
    const v = check({ answer: answer(sectionUnits()), pages: [page], material: { url: "https://git.io/abc" } });
    expect(v.refused).toBeNull();
    expect(v.toc!.chapters).toHaveLength(22);
  });

  it("rule 4: a heading unit's title must match its heading, a linked unit's a link to its page or the page's own title", () => {
    const pages = hubPages();
    const good = [
      unit("Week 1: Intro", `${REPO}/tree/main/week01`), // the link's text
      unit("Week 2: Audio features", `${REPO}/tree/main/week02`), // contained in the link's text
      unit("Week 3: Transformers", `${REPO}/tree/main/week03`), // the page's first heading
    ];
    expect(check({ answer: answer(good), pages }).toc!.chapters.map((c) => c.title)).toEqual(["Week 1: Intro", "Week 2: Audio features", "Week 3: Transformers"]);
    const made = [...good, unit("Week 9: Diffusion", `${REPO}/tree/main/week04`)];
    expect(check({ answer: answer(made), pages }).refused).toBe("units refused: 1 of 4 titles not on the page");
    // The link's text "notebook" sits inside this title, but the rest of the title is nowhere on the page.
    const padded = [...good, unit("Week 9: Diffusion notebook", `${REPO}/tree/main/week03`)];
    expect(check({ answer: answer(padded), pages }).refused).toBe("units refused: 1 of 4 titles not on the page");
    const wrongHeading = sectionUnits().map((u, i) => (i < 3 ? { ...u, title: `Kubernetes ${i}` } : u));
    expect(check({ answer: answer(wrongHeading), pages: [sectionsPage] }).refused).toBe("units refused: 3 of 22 titles not on the page");
  });

  it("rule 5: 4 of 22 titles unseen refuses the units; 2 of 22 keeps 20", () => {
    const four = sectionUnits().map((u, i) => (i < 2 ? { ...u, title: `Invented ${i}` } : i < 4 ? { ...u, at: `${REPO}#nowhere-${i}` } : u));
    expect(check({ answer: answer(four), pages: [sectionsPage] })).toEqual({
      toc: null,
      minutes: null,
      basis: null,
      list: null,
      refused: "units refused: 4 of 22 titles not on the page",
      facts: expect.any(Array),
    });
    const two = sectionUnits().map((u, i) => (i < 2 ? { ...u, title: `Invented ${i}` } : u));
    const v = check({ answer: answer(two), pages: [sectionsPage] });
    expect(v.refused).toBeNull();
    expect(v.toc!.chapters).toHaveLength(20);
    expect(v.facts).toContain("2 of 22 titles not on the page");
  });

  it("rule 6: a nested h3 inside a kept h2 unit is dropped, and so is a second unit with the same at", () => {
    const page = seen(
      REPO,
      readme("a/b", `<h2 id="user-content-alpha">Alpha</h2><p>${filler(100)}</p><h3 id="user-content-alpha-one">Alpha one</h3><p>${filler(100)}</p>${h2s(["Beta", "Gamma"], 100)}`),
    );
    const units = [unit("Alpha", `${REPO}#alpha`), unit("Alpha one", `${REPO}#alpha-one`), unit("Beta", `${REPO}#beta`), unit("Gamma", `${REPO}#gamma`), unit("Beta", `${REPO}#beta`)];
    const v = check({ answer: answer(units), pages: [page] });
    expect(v.refused).toBeNull();
    expect(v.toc!.chapters.map((c) => c.title)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(v.toc!.chapters[0].sections).toEqual(["Alpha one"]);
    expect(v.facts).toContain("2 repeated units dropped");
  });

  it("rule 7: heading units and long or timed pages are measured; short pages and PDFs keep the model's minutes", () => {
    const course = "https://example.com/course";
    const home = seen(
      course,
      `<html><head><title>Course</title></head><body><main><h1>Course</h1><ul>
        <li><a href="/video">Lecture video</a></li><li><a href="/essay">Long essay</a></li>
        <li><a href="/folder">Week folder</a></li><li><a href="/slides.pdf">Slides</a></li><li><a href="/other.pdf">Other slides</a></li></ul></main></body></html>`,
    );
    const pages = [
      home,
      bare("https://example.com/video", { title: "Lecture video", durationMinutes: 42 }),
      bare("https://example.com/essay", { title: "Long essay", words: 2300 }),
      bare("https://example.com/folder", { title: "Week folder", words: 120 }),
      bare("https://example.com/slides.pdf", { title: "Slides", pdfPages: 30 }),
      bare("https://example.com/other.pdf", { title: "Other slides", pdfPages: 12 }),
    ];
    const units = [
      unit("Lecture video", "https://example.com/video", { minutes: 5 }),
      unit("Long essay", "https://example.com/essay", { minutes: 99 }),
      unit("Week folder", "https://example.com/folder", { minutes: 25 }),
      unit("Slides", "https://example.com/slides.pdf", { minutes: 60 }),
      unit("Other slides", "https://example.com/other.pdf"),
    ];
    const v = check({ answer: answer(units), pages, material: { url: course, kind: "course" } });
    expect(v.refused).toBeNull();
    expect(v.toc!.chapters.map((c) => c.minutes)).toEqual([42, 10, 25, 60, null]);
  });

  it("a hub's week folders whose pages have 120 words each keep the model's minutes: 90, estimated", () => {
    const hub = seen(
      REPO,
      readme("a/b", `<h2 id="user-content-materials">Materials</h2><ul>${[1, 2, 3, 4].map((n) => `<li><a href="/a/b/tree/main/week0${n}">Week ${n}: Topic ${n}</a></li>`).join("")}</ul>`),
    );
    const weeks = [1, 2, 3, 4].map((n) => seen(`${REPO}/tree/main/week0${n}`, readme(`week0${n}`, `<p>${filler(120)}</p>`)));
    expect(weeks[0].words).toBe(120);
    const units = [1, 2, 3, 4].map((n) => unit(`Week ${n}: Topic ${n}`, `${REPO}/tree/main/week0${n}`, { minutes: 90, group: "Lectures" }));
    const v = check({ answer: answer(units), pages: [hub, ...weeks], material: { kind: "course" } });
    expect(v.refused).toBeNull();
    expect(v.toc!.chapters.map((c) => [c.minutes, c.url, c.group])).toEqual([1, 2, 3, 4].map((n) => [90, `${REPO}/tree/main/week0${n}`, "Lectures"]));
    expect(v.minutes).toBe(360);
    expect(v.basis).toBe("estimated");
  });

  it("rule 8: heading units covering 41% of the page are refused", () => {
    // Each section's words are its one-word title plus its filler: 14 + 14 + 13 of 100.
    const page = seen(REPO, readme("a/b", `${h2s(["Alpha", "Beta"], 13)}${h2s(["Gamma"], 12)}${h2s(["Delta"], 58)}`));
    expect(page.outline!.words).toBe(100);
    const units = ["Alpha", "Beta", "Gamma"].map((t) => unit(t, `${REPO}#${slug(t)}`));
    expect(check({ answer: answer(units), pages: [page] }).refused).toBe("units refused: cover 41% of the page");
    expect(check({ answer: answer([...units, unit("Delta", `${REPO}#delta`)]), pages: [page] }).refused).toBeNull();
  });

  it("rule 9: reading units are put in page order, a linked unit after the heading it sits under", () => {
    const page = seen(
      REPO,
      readme("a/b", `${h2s(["Alpha"], 100)}<h2 id="user-content-beta">Beta</h2><p>${filler(100)} <a href="https://example.com/extra">Extra reading</a></p>${h2s(["Gamma"], 100)}`),
    );
    const extra = bare("https://example.com/extra", { title: "Extra reading", words: 1150 });
    const units = [unit("Gamma", `${REPO}#gamma`), unit("Extra reading", "https://example.com/extra"), unit("Alpha", `${REPO}#alpha`), unit("Beta", `${REPO}#beta`)];
    const v = check({ answer: answer(units), pages: [page, extra] });
    expect(v.refused).toBeNull();
    expect(v.toc!.chapters.map((c) => [c.title, c.minutes])).toEqual([["Alpha", 1], ["Beta", 1], ["Extra reading", 5], ["Gamma", 1]]);
  });

  it("rule 9: 41 reading units are refused, and so are 2", () => {
    const titles = Array.from({ length: 41 }, (_, i) => `Part ${i + 1}`);
    const page = seen(REPO, readme("a/b", h2s(titles, 50)));
    const units = titles.map((t) => unit(t, `${REPO}#${slug(t)}`));
    expect(check({ answer: answer(units), pages: [page] }).refused).toBe("units refused: 41 reading units, more than 40");
    const small = seen(REPO, readme("a/b", h2s(["Alpha", "Beta"], 100)));
    expect(check({ answer: answer([unit("Alpha", `${REPO}#alpha`), unit("Beta", `${REPO}#beta`)]), pages: [small] }).refused).toBe("units refused: 2 reading units, fewer than 3");
  });

  it("rule 10: a book's chapters on a contents page get withChapterSizes minutes and minutes: null in the verdict", () => {
    const SLP = "https://web.stanford.edu/~jurafsky/slp3/";
    const toc = seen(SLP, fixture("book-toc"));
    const titles = ["Introduction", "Words and Tokens", "N-gram Language Models", "Logistic Regression and Text Classification", "Embeddings", "Neural Networks", "Transformers and Pretraining", "Post-training", "Masked Language Models", "Interpretability"];
    const units = [...titles.map((t) => unit(t, SLP, { minutes: 300 })), unit("Quantum Chromodynamics", SLP)];
    const v = check({ answer: answer(units), pages: [toc], material: { url: SLP, kind: "book", minutes: 1200 } });
    expect(v.refused).toBeNull();
    expect(v.toc!.url).toBe(SLP);
    expect(v.toc!.chapters.map((c) => [c.title, c.minutes, c.url])).toEqual(titles.map((t) => [t, 120, null]));
    expect(v.minutes).toBeNull();
    expect(v.basis).toBeNull();
    expect(v.facts).toContain("1 of 11 titles not on the page");
  });

  it("rule 10: a book whose chapters each point at their own fetched page keeps its contents page as the toc's url", () => {
    const BOOK = "https://example.com/book";
    const titles = ["The Shape of Data", "Counting Things", "Drawing Lines"];
    const contents = seen(BOOK, `<html><head><title>A Book</title></head><body><main><h1>Contents</h1><ol>${titles.map((t, i) => `<li><a href="/book/ch${i + 1}">${t}</a></li>`).join("")}</ol></main></body></html>`);
    const chapters = titles.map((t, i) => bare(`${BOOK}/ch${i + 1}`, { title: t, text: `${t}\n${filler(50)}` }));
    const v = check({ answer: answer(titles.map((t, i) => unit(t, `${BOOK}/ch${i + 1}`))), pages: [contents, ...chapters], material: { url: BOOK, kind: "book", minutes: 300 } });
    expect(v.refused).toBeNull();
    expect(v.toc!.url).toBe(BOOK);
    expect(v.toc!.chapters.map((c) => [c.title, c.url, c.minutes])).toEqual(titles.map((t, i) => [t, `${BOOK}/ch${i + 1}`, 100]));
  });

  it("rule 11: the toc carries sections, the unit's url when it is not the toc's, and a clipped group", () => {
    const page = seen(
      REPO,
      readme(
        "a/b",
        `<h2 id="user-content-alpha">Alpha</h2><p>${filler(50)}</p><h3 id="user-content-a1">A1</h3><p>${filler(50)}</p><h4 id="user-content-a1x">A1x</h4><p>${filler(50)}</p>` +
          `<h3 id="user-content-summary">Summary</h3><p>${filler(50)}</p><h3 id="user-content-a2">A2</h3><p>${filler(50)}</p>${h2s(["Beta", "Gamma"], 200)}`,
      ),
    );
    const long = "G".repeat(200);
    const units = [unit("Alpha", `${REPO}#alpha`, { group: long }), unit("Beta", REPO), unit("Gamma", `${REPO}#gamma`)];
    const v = check({ answer: answer(units), pages: [page] });
    expect(v.refused).toBeNull();
    expect(chapterListSchema.safeParse(v.toc).success).toBe(true);
    expect(v.toc).toMatchObject({ source: "page", url: REPO, printPages: false, end: null });
    expect(v.toc!.chapters[0]).toEqual({ n: null, title: "Alpha", page: null, minutes: 1, sections: ["A1", "A2"], url: `${REPO}#alpha`, group: `${"G".repeat(119)}…` });
    expect(v.toc!.chapters[1]).toMatchObject({ title: "Beta", url: null, group: null, sections: [] });
  });

  it("rule 12: the new size is the units' sum when every unit has minutes, and null when any lacks them", () => {
    const pages = [
      seen("https://example.com/c", `<html><body><main><a href="/a">Part A</a><a href="/b">Part B</a><a href="/c2">Part C</a></main></body></html>`),
      bare("https://example.com/a", { title: "Part A", words: 2300 }),
      bare("https://example.com/b", { title: "Part B", durationMinutes: 30 }),
      bare("https://example.com/c2", { title: "Part C", words: 690 }),
    ];
    const units = [unit("Part A", "https://example.com/a"), unit("Part B", "https://example.com/b"), unit("Part C", "https://example.com/c2")];
    const measured = check({ answer: answer(units), pages, material: { url: "https://example.com/c", kind: "course" } });
    expect([measured.minutes, measured.basis]).toEqual([43, "measured"]);
    const short = [...pages.slice(0, 3), bare("https://example.com/c2", { title: "Part C", words: 100 })];
    const estimated = check({ answer: answer(units.map((u, i) => (i === 2 ? { ...u, minutes: 20 } : u))), pages: short, material: { url: "https://example.com/c", kind: "course" } });
    expect([estimated.minutes, estimated.basis]).toEqual([60, "estimated"]);
    const unknown = check({ answer: answer(units), pages: short, material: { url: "https://example.com/c", kind: "course" } });
    expect(unknown.toc!.chapters).toHaveLength(3);
    expect([unknown.minutes, unknown.basis]).toEqual([null, null]);
  });

  it("the primer's 29 h2 sections are measured: minutes within 2 of the sum of their sections", () => {
    const v = check({ answer: answer(primerUnits()), pages: [primerPage], material: { url: PRIMER } });
    expect(v.refused).toBeNull();
    expect(primerH2).toHaveLength(29);
    expect(v.toc!.chapters).toHaveLength(29);
    expect(v.basis).toBe("measured");
    const sum = primerH2.reduce((s, h) => s + Math.max(1, Math.round(h.words / 230)), 0);
    expect(Math.abs(v.minutes! - sum)).toBeLessThanOrEqual(2);
    expect(v.toc!.chapters[0].url).toBe(`${PRIMER}#motivation`);
  });

  it("rule 13: the items tool's list is used when listUrl names it, and only for a role with practice", () => {
    const listUrl = "https://example.com/problems";
    const problems = ["Two Sum", "Valid Anagram", "Group Anagrams", "Top K Frequent Elements"];
    const page = bare(listUrl, { title: "Problems", text: problems.join("\n") });
    const list: PracticeList = {
      source: "page",
      url: listUrl,
      items: problems.map((title) => ({ title, number: null, group: null, difficulty: null, url: null, solutionUrl: null, minutes: null })),
    };
    const withUnits = check({
      answer: answer(sectionUnits(), { listUrl: `${listUrl}/` }),
      pages: [sectionsPage, page],
      role: "both",
      material: { practice: PRACTICE },
      lists: [list],
    });
    expect(withUnits.toc!.chapters).toHaveLength(22);
    expect(withUnits.list!.items.map((i) => i.title)).toEqual(problems);
    const readRole = check({ answer: answer(sectionUnits(), { listUrl }), pages: [sectionsPage, page], role: "read", material: { practice: PRACTICE }, lists: [list] });
    expect(readRole.toc!.chapters).toHaveLength(22);
    expect(readRole.list).toBeNull();
    expect(check({ answer: answer([], { whole: true, listUrl }), pages: [page], role: "read", lists: [list] }).list).toBeNull();
  });

  it("rule 1: a whole practice-role answer still returns the items tool's list its listUrl names", () => {
    const listUrl = "https://neetcode.io/practice";
    const problems = ["Two Sum", "Valid Anagram", "Group Anagrams", "Top K Frequent Elements"];
    const page = bare(listUrl, { title: "NeetCode 150", text: problems.join("\n") });
    const list: PracticeList = {
      source: "page",
      url: listUrl,
      items: problems.map((title) => ({ title, number: null, group: null, difficulty: null, url: null, solutionUrl: null, minutes: null })),
    };
    const v = check({ answer: answer([], { whole: true, listUrl }), pages: [page], role: "practice", material: { url: listUrl, practice: PRACTICE }, lists: [list] });
    expect(v.toc).toBeNull();
    expect(v.refused).toBeNull();
    expect([v.minutes, v.basis]).toEqual([null, null]);
    expect(v.list).toEqual(list);
    expect(v.facts[0]).toBe("whole");
  });

  it("rule 5: mostly invented practice titles keep the reading toc and make no practice-units list", () => {
    const units = [
      ...sectionUnits(),
      unit("Section 1", `${REPO}#section-1`, { kind: "practice" }),
      ...[1, 2, 3].map((i) => unit(`Invented lab ${i}`, `${REPO}#section-${i + 1}`, { kind: "practice" })),
    ];
    const v = check({ answer: answer(units), pages: [sectionsPage], role: "both", material: { practice: PRACTICE } });
    expect(v.refused).toBeNull();
    expect(v.toc!.chapters).toHaveLength(22);
    expect([v.minutes, v.basis]).toEqual([22, "measured"]);
    expect(v.list).toBeNull();
    expect(v.facts).toContain("practice units refused: 3 of 4 titles not on the page");
  });

  it("rule 13: practice units that fail the item check never refuse the reading toc", () => {
    const units = [...sectionUnits().slice(0, 20), unit("Section 21", `${REPO}#section-21`, { kind: "practice" }), unit("Section 22", `${REPO}#section-22`, { kind: "practice" })];
    const v = check({ answer: answer(units), pages: [sectionsPage], role: "both", material: { practice: PRACTICE } });
    expect(v.refused).toBeNull();
    expect(v.toc!.chapters).toHaveLength(20);
    expect(v.list).toBeNull(); // two items are fewer than MIN_PRACTICE_ITEMS
  });
});
