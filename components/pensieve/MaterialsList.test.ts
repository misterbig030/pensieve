import { describe, expect, it } from "vitest";
import type { Material, MaterialPractice } from "@/lib/schemas/material";
import { materialTotals, practiceTag, shownRows, splitCoverage } from "./MaterialsList";

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
