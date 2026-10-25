import type { MaterialPractice, PracticeItem, PracticeList } from "@/lib/schemas/material";

/** Three groups of a problem list in its own order: Arrays & Hashing 1–9, Two Pointers 10–14, Stack 15–21. */
const ROWS: [string, string, string, PracticeItem["difficulty"]][] = [
  ["217", "Contains Duplicate", "Arrays & Hashing", "easy"],
  ["242", "Valid Anagram", "Arrays & Hashing", "easy"],
  ["1", "Two Sum", "Arrays & Hashing", "easy"],
  ["49", "Group Anagrams", "Arrays & Hashing", "medium"],
  ["347", "Top K Frequent Elements", "Arrays & Hashing", "medium"],
  ["271", "Encode and Decode Strings", "Arrays & Hashing", "medium"],
  ["238", "Product of Array Except Self", "Arrays & Hashing", "medium"],
  ["36", "Valid Sudoku", "Arrays & Hashing", "medium"],
  ["128", "Longest Consecutive Sequence", "Arrays & Hashing", "medium"],
  ["125", "Valid Palindrome", "Two Pointers", "easy"],
  ["167", "Two Sum II", "Two Pointers", "medium"],
  ["15", "3Sum", "Two Pointers", "medium"],
  ["11", "Container With Most Water", "Two Pointers", "medium"],
  ["42", "Trapping Rain Water", "Two Pointers", "hard"],
  ["20", "Valid Parentheses", "Stack", "easy"],
  ["155", "Min Stack", "Stack", "medium"],
  ["150", "Evaluate Reverse Polish Notation", "Stack", "medium"],
  ["22", "Generate Parentheses", "Stack", "medium"],
  ["739", "Daily Temperatures", "Stack", "medium"],
  ["853", "Car Fleet", "Stack", "medium"],
  ["84", "Largest Rectangle in Histogram", "Stack", "hard"],
];

export const PROBLEM_ITEMS: PracticeItem[] = ROWS.map(([number, title, group, difficulty]) => ({ title, number, group, difficulty, url: null, solutionUrl: null, minutes: null }));

export const PROBLEM_LIST: PracticeList = { items: PROBLEM_ITEMS, source: "file", url: "https://example.com/problems.json" };

/** A 21-problem list kept whole: 5 easy at 15 min, 14 medium at 25, 2 hard at 35: 495 min in all. */
export const LISTED_PROBLEMS: MaterialPractice = { format: "problem-set", items: 21, totalItems: 21, perItemMinutes: 10, minutes: 495, answers: true, list: PROBLEM_LIST };
