import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { LISTED_PROBLEMS, PROBLEM_ITEMS } from "@/lib/__fixtures__/problemList";
import type { Material, PracticeItem, PracticeRef } from "@/lib/schemas/material";
import { practiceRowsFor, type ReadRow } from "@/components/pensieve/ReadTable";
import { dayTasks, lessonMinutes, lessonPreview, taskHref, taskTitle } from "./dayTasks";

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
const noteRow: ReadRow = {
  material: { ...book, id: "mine", type: "note", title: "My notes on evals", url: "note:mine" },
  tier: "should",
  minutes: 10,
  note: null,
  chapter: null,
  activity: "read",
  key: "mine#0",
};

const items: PracticeItem[] = PROBLEM_ITEMS.map((it) => ({ ...it }));
items[3] = { ...items[3], url: "https://leetcode.com/problems/group-anagrams/", solutionUrl: "https://neetcode.io/solutions/group-anagrams" };
const bank: Material = { ...AIE_MATERIALS.find((m) => m.id === "evals")!, id: "nc", title: "NeetCode 150", practice: { ...LISTED_PROBLEMS, list: { ...LISTED_PROBLEMS.list!, items } } };
const byId = new Map([[bank.id, bank]]);
const anagrams: PracticeRef = { format: "problem-set", id: "nc", task: "NeetCode 150 · problem", done: "solved without hints", minutes: 25, generated: false, itemFrom: 4, itemTo: 4 };
const summary: PracticeRef = { format: "recall", id: null, task: "Write a summary of chapter 3", done: "a page of notes", minutes: 15, generated: true };

describe("dayTasks", () => {
  it("orders read tasks before practice and labels them T1…Tn", () => {
    const tasks = dayTasks([chapterRow], practiceRowsFor([anagrams, summary], byId));
    expect(tasks.map((t) => [t.kind, t.token])).toEqual([
      ["read", "T1"],
      ["practice", "T2"],
      ["practice", "T3"],
    ]);
  });

  it("gives a read task the id read:<row key>", () => {
    expect(dayTasks([chapterRow], [])[0]!.id).toBe("read:aie#3");
  });

  it("gives a practice task an id from its source and item, not its position", () => {
    const first = dayTasks([], practiceRowsFor([anagrams], byId))[0]!;
    const third = dayTasks([], practiceRowsFor([summary, { ...summary, task: "Another" }, anagrams], byId))[2]!;
    expect(first.id).toBe("practice:problem-set#nc#4");
    expect(third.id).toBe(first.id);
  });

  it("falls back to the task text for a practice row without an item", () => {
    expect(dayTasks([], practiceRowsFor([summary], byId))[0]!.id).toBe("practice:recall#generated#write-a-summary-of-chapter-3");
  });

  it("keeps ids unique when two rows have the same content", () => {
    const tasks = dayTasks([], practiceRowsFor([summary, summary], byId));
    expect(tasks.map((t) => t.id)).toEqual(["practice:recall#generated#write-a-summary-of-chapter-3", "practice:recall#generated#write-a-summary-of-chapter-3~2"]);
  });

  it('titles a chapter row "<short title>, ch. <n>" and a problem by its item', () => {
    const [read, problem, recall] = dayTasks([chapterRow], practiceRowsFor([anagrams, summary], byId));
    expect(taskTitle(read!)).toBe("AI Engineering, ch. 3");
    expect(taskTitle(problem!)).toBe("49. Group Anagrams");
    expect(taskTitle(recall!)).toBe("Write a summary of chapter 3");
  });

  it("links a chapter row to the chapter's page, a problem to its item, and a note to nothing", () => {
    const [read, note, problem] = dayTasks([chapterRow, noteRow], practiceRowsFor([anagrams], byId));
    expect(taskHref(read!)).toBe("https://book.example/ch3");
    expect(taskHref(note!)).toBeNull();
    expect(taskHref(problem!)).toBe("https://leetcode.com/problems/group-anagrams/");
  });

  it("previews each task as one line", () => {
    expect(lessonPreview(dayTasks([chapterRow, { ...chapterRow, activity: "review", key: "aie#2" }], practiceRowsFor([anagrams], byId)))).toEqual([
      "Read AI Engineering, ch. 3",
      "Review AI Engineering, ch. 3",
      "Problems: 49. Group Anagrams",
    ]);
  });
});

describe("lessonMinutes", () => {
  const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

  it("estimates the lesson at 200 words a minute, rounded to 5, at least 5", () => {
    expect(lessonMinutes(words(30))).toBe(5);
    expect(lessonMinutes(words(2000))).toBe(10);
    expect(lessonMinutes(words(2600))).toBe(15);
  });
});
