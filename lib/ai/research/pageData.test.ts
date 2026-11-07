import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { applyMapping, sampleDataFile, type FieldMapping } from "./dataFile";
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
    expect(pageLists(COURSE)[0]).toMatchObject({ records: 77 });
    expect(pageLists(COURSE)[0].fields).not.toContain("_key");
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
    expect(pageLists(COURSE).map((l) => [l.records, l.fields[0]])).toEqual([
      [77, "index"],
      [20, "id"],
      [7, "answer"],
      [6, "name"],
    ]);
    // A render tree that carries one list twice names it once.
    const lessons = Array.from({ length: 6 }, (_, i) => ({ title: `Lab ${i}`, kind: "lab" }));
    const twice = `<script type="application/json">${JSON.stringify({ a: { lessons }, b: { lessons } })}</script>`;
    expect(pageLists(twice)).toEqual([{ records: 6, fields: ["title", "kind"] }]);
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
    const block = JSON.stringify(Array.from({ length: 70_000 }, (_, i) => ({ t: i })));
    const html = Array.from({ length: 3 }, () => `<script type="application/json">${block}</script>`).join("");
    expect(pageDataFile(html)!.file.sets.map((s) => s.path)).toEqual(["script1", "script2"]);
  });

  it("finds nothing on a page with no data for its scripts", () => {
    expect(pageDataFile("<html><body><h1>Course</h1><p>Lessons</p></body></html>")).toBeNull();
    expect(pageLists('<script type="application/json">{"a":1}</script>')).toEqual([]);
  });

  it("reads a JSON script block's lists, such as __NEXT_DATA__", () => {
    const next = { props: { pageProps: { course: { lessons: [1, 2, 3, 4].map((i) => ({ title: `Lab ${i}`, kind: "lab", minutes: 30 })) } } } };
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></body></html>`;
    const data = pageDataFile(html)!;
    expect(data.file.sets.map((s) => s.path)).toEqual(["script1.props.pageProps.course.lessons"]);
    // Four lessons are too few to tell the structure finder of.
    expect(pageLists(html)).toEqual([]);
  });
});
