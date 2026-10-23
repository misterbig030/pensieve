import { describe, expect, it } from "vitest";
import { applyMapping, fieldValue, fillTemplate, parseDataFile, parseDelimited, type FieldMapping } from "./dataFile";

const mapping = (extra: Partial<FieldMapping> = {}): FieldMapping => ({
  found: true,
  path: "",
  title: "t",
  number: null,
  group: null,
  difficulty: null,
  minutes: null,
  url: null,
  solutionUrl: null,
  subset: null,
  ...extra,
});

describe("data files", () => {
  it("splits CSV and TSV with quoted delimiters, doubled quotes and line breaks", () => {
    expect(parseDelimited('a,b\n"x, y","say ""hi"""\r\n"two\nlines",z\n', ",")).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["two\nlines", "z"],
    ]);
    const tsv = parseDataFile("title\tlevel\nA\teasy\nB\thard\nC\tmedium\n")!;
    expect(tsv.kind).toBe("csv");
    expect(tsv.sets[0].records.map((r) => r.value)).toEqual([
      { title: "A", level: "easy" },
      { title: "B", level: "hard" },
      { title: "C", level: "medium" },
    ]);
  });

  it("drops the half row a file cut at the size limit ends in", () => {
    const cut = parseDataFile("t,n\nA,1\nB,2\nC,3\nD,", true)!;
    expect(cut.sets[0].records.map((r) => r.value.t)).toEqual(["A", "B", "C"]);
  });

  it("is null for prose, broken JSON, and JSON with no list of records", () => {
    expect(parseDataFile("A page about problems.\nIt has two lines.")).toBeNull();
    expect(parseDataFile('[{"t": "A"}, {"t": "B"')).toBeNull();
    expect(parseDataFile('{"name": "x", "tags": ["a", "b", "c"]}')).toBeNull();
  });

  it("finds record sets under keys and nested in arrays", () => {
    const file = parseDataFile(JSON.stringify({ meta: { v: 1 }, data: { problems: [{ t: "A" }, { t: "B" }, { t: "C" }] }, sections: [{ n: "S1", items: [{ t: "D" }, { t: "E" }] }, { n: "S2", items: [{ t: "F" }] }] }))!;
    expect(file.sets.map((s) => [s.path, s.records.length])).toEqual([
      ["data.problems", 3],
      ["sections[].items", 3],
    ]);
    expect(file.sets[1].parentKeys).toEqual(["n", "items"]);
  });

  it("reads fields by dot path and from the parent, and fills templates only when every field has a value", () => {
    const record = { value: { slug: "two sum", meta: { id: 1 }, empty: "" }, parent: { name: "Arrays" } };
    expect(fieldValue(record, "meta.id")).toBe("1");
    expect(fieldValue(record, "../name")).toBe("Arrays");
    expect(fieldValue(record, "empty")).toBeNull();
    expect(fieldValue(record, "meta")).toBeNull();
    expect(fillTemplate("https://example.com/p/{slug}/", record)).toBe("https://example.com/p/two%20sum/");
    expect(fillTemplate("https://example.com/p/{missing}", record)).toBeNull();
    expect(fillTemplate("http://example.com/{slug}", record)).toBeNull();
    expect(fillTemplate("{slug}", { value: { slug: "https://example.com/x" }, parent: null })).toBe("https://example.com/x");
  });

  it("keeps the named subset in file order, matching the flag's value in any case", () => {
    const file = parseDataFile(JSON.stringify([{ t: "A", in: true }, { t: "B", in: false }, { t: "C", in: "TRUE" }, { t: "D" }]))!;
    expect(applyMapping(file, mapping({ subset: { field: "in", equals: "True" } }))!.map((d) => d.title)).toEqual(["A", "C"]);
    expect(applyMapping(file, mapping({ subset: { field: "nope", equals: "true" } }))).toBeNull();
    expect(applyMapping(file, mapping({ path: "elsewhere" }))).toBeNull();
    expect(applyMapping(file, mapping({ found: false }))).toBeNull();
  });
});
