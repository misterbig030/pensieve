import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { LISTED_PROBLEMS, PROBLEM_ITEMS } from "@/lib/__fixtures__/problemList";
import type { Material, PracticeItem } from "@/lib/schemas/material";
import { practiceRowsFor, type ReadRow } from "@/components/pensieve/ReadTable";
import { RailChecklist } from "./RailChecklist";

const book: Material = { ...AIE_MATERIALS.find((m) => m.id === "aie")!, url: "https://book.example/" };
const chapterRow: ReadRow = {
  material: book,
  tier: "must",
  minutes: 40,
  note: "sections 3.1–3.3",
  chapter: { n: 3, title: "Evaluation Methodology", url: "https://book.example/ch3" } as ReadRow["chapter"],
  activity: "read",
  key: "aie#3",
};

const items: PracticeItem[] = PROBLEM_ITEMS.map((it) => ({ ...it }));
items[3] = { ...items[3], url: "https://leetcode.com/problems/group-anagrams/", solutionUrl: "https://neetcode.io/solutions/group-anagrams" };
const bank: Material = { ...AIE_MATERIALS.find((m) => m.id === "evals")!, id: "nc", title: "NeetCode 150", practice: { ...LISTED_PROBLEMS, list: { ...LISTED_PROBLEMS.list!, items } } };
const practiceRows = practiceRowsFor(
  [{ format: "problem-set", id: "nc", task: "NeetCode 150 · problem", done: "solved without hints", minutes: 25, generated: false, itemFrom: 4, itemTo: 4 }],
  new Map([[bank.id, bank]]),
);

const render = () => renderToStaticMarkup(createElement(RailChecklist, { readRows: [chapterRow], practiceRows })).replace(/<!-- -->/g, "");

describe("RailChecklist", () => {
  it("links a reading to its chapter and shows which sections to read", () => {
    const html = render();
    expect(html).toMatch(/<a href="https:\/\/book.example\/ch3"[^>]*>/);
    expect(html).toContain("sections 3.1–3.3");
  });

  it("links a listed problem and its solution, and names where it comes from", () => {
    const html = render();
    expect(html).toMatch(/<a href="https:\/\/leetcode.com\/problems\/group-anagrams\/"[^>]*>49\. Group Anagrams<\/a>/);
    expect(html).toMatch(/<a href="https:\/\/neetcode.io\/solutions\/group-anagrams"[^>]*>solution<\/a>/);
    expect(html).toContain("NeetCode 150");
  });

  it("keeps the links outside the tick buttons", () => {
    expect(render()).not.toMatch(/<button(?:(?!<\/button>)[\s\S])*<a /);
  });
});
