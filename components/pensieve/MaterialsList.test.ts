import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Material, MaterialPractice } from "@/lib/schemas/material";
import { MaterialsList, materialTotals, practiceTag, shownRows, splitCoverage, type MaterialsListProps } from "./MaterialsList";

const practice = (over: Partial<MaterialPractice> = {}): MaterialPractice => ({ format: "problem-set", items: 150, perItemMinutes: 10, minutes: 1500, answers: true, ...over });
const material = (over: Partial<Material>): Material => ({ id: "M1", title: "T", kind: "book", minutes: null, practice: null, ...over }) as Material;

describe("practiceTag", () => {
  it("names the format, the count and whether answers come with it", () => {
    expect(practiceTag(practice())).toBe("Problems · 150 problems · answers included");
    expect(practiceTag(practice({ format: "recall", items: 1, answers: false }))).toBe("Recall · 1 question");
    expect(practiceTag(practice({ format: "mock", items: null, answers: true }))).toBe("Mock · answers included");
    expect(practiceTag(practice({ items: 75, totalItems: 150 }))).toBe("Problems · 75 of 150 problems · answers included");
  });
});

describe("materialTotals", () => {
  it("counts a practice-only bank as practice minutes only", () => {
    const bank = material({ minutes: null, practice: practice({ minutes: 600 }) });
    expect(materialTotals([bank])).toEqual({ readingMinutes: 0, practiceMinutes: 600 });
  });
  it("counts a book with exercises as both reading and practice", () => {
    const book = material({ minutes: 300, practice: practice({ minutes: 120 }) });
    const plain = material({ id: "M2", minutes: 35 });
    expect(materialTotals([book, plain])).toEqual({ readingMinutes: 335, practiceMinutes: 120 });
  });
  it("ignores a practice source with no size", () => {
    expect(materialTotals([material({ practice: practice({ minutes: null }) })])).toEqual({ readingMinutes: 0, practiceMinutes: 0 });
  });
});

describe("splitCoverage", () => {
  it("separates open practice picks, as their labels, from uncovered topic areas", () => {
    expect(splitCoverage(["Retrieval", "practice: Problems", "Evals", "practice: Mock"])).toEqual({ areas: ["Retrieval", "Evals"], practice: ["Problems", "Mock"] });
    expect(splitCoverage([])).toEqual({ areas: [], practice: [] });
    expect(splitCoverage(["Practice: Problems"])).toEqual({ areas: [], practice: ["Problems"] });
  });
});

describe("shownRows", () => {
  it("cuts the reading groups and the Practice group each, so the Practice group shows before Show all", () => {
    const reading = ["R1", "R2", "R3", "R4", "R5"].map((id) => material({ id, minutes: 60 }));
    const bank = (id: string) => material({ id, practice: practice() });
    const ordered = [...reading, bank("P1"), bank("P2")];
    expect(shownRows(ordered, 4).map((m) => m.id)).toEqual(["R1", "R2", "R3", "R4", "P1", "P2"]);
    expect(shownRows([...ordered, bank("P3"), bank("P4"), bank("P5")], 4).map((m) => m.id)).toEqual(["R1", "R2", "R3", "R4", "P1", "P2", "P3", "P4"]);
    expect(shownRows(reading.slice(0, 2), 4)).toHaveLength(2);
  });
});

const render = (props: Partial<MaterialsListProps>) =>
  renderToStaticMarkup(createElement(MaterialsList, { topic: "T", materials: [material({ id: "M1", title: "Book", origin: "research" })], ...props }));

describe("MaterialsList coverage and dropped groups", () => {
  const coverage = { covered: ["Arrays"], open: ["Graphs"] };

  it("labels research's coverage as what research found, and the plan's as covered and not covered", () => {
    const research = render({ coverage, coverageSource: "research" });
    expect(research).toContain("Research found");
    expect(research).toContain("Arrays");
    expect(research).not.toContain("Covered");
    expect(research).not.toContain("Not covered");

    const plan = render({ coverage, coverageSource: "plan" });
    expect(plan).toContain("Covered");
    expect(plan).toContain("Not covered");
    expect(plan).not.toContain("Research found");
  });

  it("splits what was left out into rejected by checks and found but not used", () => {
    const html = render({
      dropped: [
        { title: "Dead page", reason: "page would not open" },
        { title: "Old edition", reason: "title mismatch", stage: "checks" },
        { title: "Long video", reason: "not used by the plan: too long", stage: "plan" },
      ],
    });
    expect(html).toContain("Rejected by checks");
    expect(html).toContain("Found but not used");
    const [checks, notUsed] = html.split("Found but not used").map((part, i) => (i === 0 ? part.slice(part.indexOf("Rejected by checks")) : part));
    expect(checks).toContain("Dead page");
    expect(checks).toContain("Old edition");
    expect(checks).not.toContain("Long video");
    expect(notUsed).toContain("Long video");
    expect(notUsed).toContain("not used by the plan: too long");
    const text = html.replace(/<!-- -->/g, "");
    expect(text).toContain("Rejected by checks (2)");
    expect(text).toContain("Found but not used (1)");
  });

  it("shows only the group that has entries", () => {
    const html = render({ dropped: [{ title: "Long video", reason: "too long", stage: "plan" }] });
    expect(html).toContain("Found but not used");
    expect(html).not.toContain("Rejected by checks");
  });
});
