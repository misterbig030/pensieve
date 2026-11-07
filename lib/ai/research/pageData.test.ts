import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { applyMapping, sampleDataFile, type FieldMapping } from "./dataFile";
import { validateItemList } from "./itemFinder";
import { pageDataFile, pageDataRoots, pageLists } from "./pageData";

function fixture(name: string): string {
  return gunzipSync(readFileSync(join(__dirname, "__fixtures__", "pages", `${name}.html.gz`))).toString("utf8");
}

/** A course page drawn by Next.js (aieng-2's RAG course): its text names five modules, its data holds all 77 lessons. */
const COURSE = fixture("course-page-data");
const LESSONS = "row73[3][3].children[0][3].courses[0].lessons.*";

const LABS: FieldMapping = {
  found: true,
  path: LESSONS,
  title: "name",
  number: null,
  group: null,
  difficulty: null,
  minutes: "time",
  minutesUnit: "seconds",
  url: null,
  solutionUrl: null,
  subset: { field: "type", equals: ["notebook", "graded_notebook"] },
};

describe("page data", () => {
  it("reads the RSC payload's rows and the page's JSON scripts", () => {
    const names = pageDataRoots(COURSE).map((r) => r.name);
    expect(names).toContain("row73");
    expect(names.some((n) => n.startsWith("script"))).toBe(true);
  });

  it("finds the course's lessons deep in the render tree, the largest list on the page", () => {
    const data = pageDataFile(COURSE)!;
    const lessons = data.file.sets.find((s) => s.path === LESSONS)!;
    expect(lessons.records).toHaveLength(77);
    expect(lessons.keys).toEqual(expect.arrayContaining(["name", "type", "time"]));
    // The record sits in the course object: its fields are the lessons' parent fields.
    expect(lessons.parentKeys).toContain("totalDurationSeconds");
    expect(pageLists(COURSE).lists[0]).toMatchObject({ records: 77 });
    expect(pageLists(COURSE).lists[0].fields).not.toContain("_key");
    // The lesson names are in the data's text, where a mapped title must appear.
    expect(data.text).toContain("Implementing retriever functions in a RAG system");
  });

  it("shows the model every kind of lesson, though the first 20 records hold only some", () => {
    const sample = sampleDataFile(pageDataFile(COURSE)!.file);
    expect(sample).toContain(`Records at path "${LESSONS}": 77`);
    expect(sample).toContain('Values of type over all 77 records: "video" (49), "notebook" (9), "reading_material" (9), "quiz" (5), "graded_notebook" (5)');
    expect(sample).not.toMatch(/CSV rows/);
  });

  it("names every list past the four it samples, so a smaller one can still be mapped by its path", () => {
    const sample = sampleDataFile(pageDataFile(COURSE)!.file);
    expect(sample).toContain("Other record sets, not sampled (path: records; fields):");
    expect(sample).toContain('"row73[3][3].children[0][3].courses[0].listing": 5; timeFrame, moduleLabel, name, content, progress');
    expect(sample).toContain('"row73[3][3].children[0][3].courses[0].listing[4].content": 5; key, type');
    // The lessons, the largest, are still sampled in full.
    expect(sample.indexOf(`Records at path "${LESSONS}"`)).toBeLessThan(sample.indexOf("Other record sets"));
  });

  it("lists the page's sizable lists once each, largest first, at most four", () => {
    expect(pageLists(COURSE).lists.map((l) => [l.records, l.fields[0]])).toEqual([
      [77, "index"],
      [20, "id"],
      // The contents of the course's five listing entries, gathered across them.
      [20, "key"],
      [7, "answer"],
    ]);
    // A render tree that carries one list twice names it once.
    const lessons = Array.from({ length: 6 }, (_, i) => ({ title: `Lab ${i}`, kind: "lab" }));
    const twice = `<script type="application/json">${JSON.stringify({ a: { lessons }, b: { lessons } })}</script>`;
    expect(pageLists(twice).lists).toEqual([{ records: 6, fields: ["title", "kind"] }]);
  });

  it("maps the labs out of the lessons, both kinds, their seconds as minutes", () => {
    const drafts = applyMapping(pageDataFile(COURSE)!.file, LABS)!;
    expect(drafts).toHaveLength(14);
    expect(drafts.slice(0, 3).map((d) => [d.title, d.minutes])).toEqual([
      ["- A brief Python refresher", 10],
      ["LLM Calls and Crafting Simple Augmented Prompts", 10],
      ["Introduction to RAG systems", 180],
    ]);
    expect(drafts.reduce((sum, d) => sum + (d.minutes ?? 0), 0)).toBe(1130); // 9 notebooks, 440 min; 5 graded, 690 min
  });

  it("walks one budget of nodes for the whole page, not one per script block", () => {
    // Three blocks of 70k records, 140k nodes each: the page's budget of 200k runs out in the second.
    const block = (b: number) => JSON.stringify(Array.from({ length: 70_000 }, (_, i) => ({ t: b * 100_000 + i })));
    const html = [0, 1, 2].map((b) => `<script type="application/json">${block(b)}</script>`).join("");
    const data = pageDataFile(html)!;
    expect(data.file.sets.map((s) => s.path)).toEqual(["script1", "script2"]);
    // The cut is said, to the mapping call and to the structure finder.
    expect(data.file.cut).toBe(true);
    expect(sampleDataFile(data.file)).toContain("This data was too large to read whole");
    expect(pageLists(html).cut).toBe(true);
    expect(pageDataFile(COURSE)!.file.cut).toBe(false);
  });

  it("gathers a list kept in each of several records, such as a course's lessons in each of its modules", () => {
    const modules = [1, 2, 3].map((m) => ({ title: `Module ${m}`, lessons: [1, 2, 3, 4].map((l) => ({ name: `Lesson ${m}.${l}`, kind: l === 4 ? "lab" : "video" })) }));
    const html = `<script type="application/json">${JSON.stringify({ course: { modules } })}</script>`;
    const data = pageDataFile(html)!;
    const lessons = data.file.sets.find((s) => s.path === "script1.course.modules[].lessons")!;
    expect(lessons.records).toHaveLength(12);
    expect(lessons.parentKeys).toContain("title");
    expect(pageLists(html).lists).toContainEqual({ records: 12, fields: ["name", "kind"] });
    const labs = applyMapping(data.file, { ...LABS, path: "script1.course.modules[].lessons", group: "../title", minutes: null, minutesUnit: "minutes", subset: { field: "kind", equals: ["lab"] } })!;
    expect(labs.map((d) => [d.title, d.group])).toEqual([
      ["Lesson 1.4", "Module 1"],
      ["Lesson 2.4", "Module 2"],
      ["Lesson 3.4", "Module 3"],
    ]);
  });

  it("keeps a list the page's data carries twice once, at its first path", () => {
    const lessons = Array.from({ length: 6 }, (_, i) => ({ title: `Lab ${i}`, kind: "lab" }));
    const html = `<script type="application/json">${JSON.stringify({ a: { lessons }, b: { lessons } })}</script>`;
    expect(pageDataFile(html)!.file.sets.map((s) => s.path)).toEqual(["script1.a.lessons"]);
  });

  it("keeps the data's strings as its text, so a title with a line break in it is still found", () => {
    const lessons = [1, 2, 3, 4, 5].map((i) => ({ title: `Lab ${i}:\n"Retrievers" \\ part ${i}`, kind: "lab" }));
    const html = `<script type="application/json">${JSON.stringify({ lessons })}</script>`;
    const data = pageDataFile(html)!;
    const drafts = applyMapping(data.file, { ...LABS, path: "script1.lessons", title: "title", minutes: null, minutesUnit: "minutes", subset: null })!;
    expect(validateItemList({ url: "https://example.com/course", source: "file", items: drafts }, data.text)?.items).toHaveLength(5);
  });

  it("finds nothing on a page with no data for its scripts", () => {
    expect(pageDataFile("<html><body><h1>Course</h1><p>Lessons</p></body></html>")).toBeNull();
    expect(pageLists('<script type="application/json">{"a":1}</script>').lists).toEqual([]);
  });

  it("reads a JSON script block's lists, such as __NEXT_DATA__", () => {
    const next = { props: { pageProps: { course: { lessons: [1, 2, 3, 4].map((i) => ({ title: `Lab ${i}`, kind: "lab", minutes: 30 })) } } } };
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></body></html>`;
    const data = pageDataFile(html)!;
    expect(data.file.sets.map((s) => s.path)).toEqual(["script1.props.pageProps.course.lessons"]);
    // Four lessons are too few to tell the structure finder of.
    expect(pageLists(html).lists).toEqual([]);
  });
});
