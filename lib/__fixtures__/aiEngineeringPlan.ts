import { layout, makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import type { ChapterList, CoverRef, Material, MaterialRef } from "@/lib/schemas/material";

/**
 * The plan "AI engineer interview preparation" as drafted on 2026-10-17 (90 days, 6 hours a week, 40% reading), in
 * the shapes this branch introduces: chapter references by position, an activity per row. Cleaned for tests: the
 * draft's three overlaps are gone (the evals essay read twice, the OpenAI docs and the question bank reserved by month 3
 * and read in month 1; the docs are now reserved by month 1), the RAG course is trimmed from 26 h to 4 h so month 2 fits its budget, and week 4's review rows
 * are musts.
 */
export const AIE_TOC: ChapterList = {
  source: "catalogue",
  url: "https://openlibrary.org/books/OL54058212M",
  printPages: false,
  end: null,
  chapters: [
    { n: 1, title: "Introduction to Building AI Applications with Foundation Models", page: null, minutes: 107, sections: ["The Rise of AI Engineering", "Foundation Model Use Cases", "Planning AI Applications", "The AI Engineering Stack"] },
    { n: 2, title: "Understanding Foundation Models", page: null, minutes: 140, sections: ["Training Data", "Modeling", "Post-Training", "Sampling"] },
    { n: 3, title: "Evaluation Methodology", page: null, minutes: 93, sections: [] },
    { n: 4, title: "Evaluate AI Systems", page: null, minutes: 126, sections: [] },
    { n: 5, title: "Prompt Engineering", page: null, minutes: 98, sections: [] },
    { n: 6, title: "RAG and Agents", page: null, minutes: 127, sections: [] },
    { n: 7, title: "Finetuning", page: null, minutes: 126, sections: [] },
    { n: 8, title: "Dataset Engineering", page: null, minutes: 93, sections: [] },
    { n: 9, title: "Inference Optimization", page: null, minutes: 99, sections: [] },
    { n: 10, title: "AI Engineering Architecture and User Feedback", page: null, minutes: 96, sections: [] },
  ],
};

function material(id: string, title: string, extra: Partial<Material>): Material {
  return {
    id,
    origin: "research",
    type: "link",
    kind: "essay",
    url: `https://example.com/${id}`,
    title,
    author: null,
    year: null,
    why: null,
    backbone: false,
    verifiedAt: null,
    fetchedTitle: null,
    recommendedBy: [],
    sig: null,
    ...extra,
  };
}

export const AIE_MATERIALS: Material[] = [
  material("aie", "AI Engineering: Building Applications with Foundation Models", { kind: "book", backbone: true, author: "Chip Huyen", year: 2024, minutes: 1105, toc: AIE_TOC }),
  material("agents", "Building Effective AI Agents", { minutes: 12 }),
  material("evals", "AI Evals: Everything You Need to Know", { minutes: 79 }),
  material("oaievals", "Working with evals | OpenAI API", { kind: "docs", minutes: 30 }),
  material("rag", "Retrieval Augmented Generation (RAG)", { kind: "course", minutes: 240 }),
  material("prachub", "AI Engineer Interview Questions 2026", { minutes: 10 }),
  material("techscreen", "AI Engineer Interview Questions 2026: LLM, RAG and Agents", { minutes: 16 }),
];

export const AIE_HOURS = 6;
export const AIE_SHARE = 0.4;

const read = (chapter: number, minutes: number): MaterialRef => ({ id: "aie", tier: "must", minutes, note: null, chapter });

/** Month 1 planned into four leaf weeks; months 2 and 3 are headings. Node ids: m1, w1–w4, m2, m3. */
export function aiePlan(): PlanNode {
  return layout(
    makeRoot([
      makeNode({
        id: "m1",
        level: "month",
        title: "Foundation Models and Evaluation Fundamentals",
        summary: "How foundation models work, how to measure them, and why evaluation comes first.",
        len: 30,
        covers: [...[1, 2, 3, 4].map((chapter): CoverRef => ({ id: "aie", note: null, chapter })), { id: "evals", note: null }, { id: "oaievals", note: null }],
        children: [
          makeNode({ id: "w1", level: "week", title: "How Foundation Models Work", summary: "Training, learning, capabilities.", len: 7, budgetHours: 6, materials: [read(1, 107), read(2, 140)] }),
          makeNode({ id: "w2", level: "week", title: "Measuring Model Performance", summary: "Evaluation methodology.", len: 7, budgetHours: 6, materials: [read(3, 93), read(4, 126)] }),
          makeNode({
            id: "w3",
            level: "week",
            title: "LLM Evaluation in Practice",
            summary: "Evaluation strategies for LLM products.",
            len: 8,
            budgetHours: 7,
            materials: [
              { id: "evals", tier: "must", minutes: 79, note: null },
              { id: "oaievals", tier: "should", minutes: 30, note: null },
            ],
          }),
          makeNode({
            id: "w4",
            level: "week",
            title: "Evaluation and Interview Patterns",
            summary: "Synthesis and interview practice.",
            len: 8,
            budgetHours: 7,
            materials: [1, 2, 3, 4].map((chapter): MaterialRef => ({ id: "aie", tier: "must", minutes: 15, note: null, chapter, activity: "review" })),
          }),
        ],
      }),
      makeNode({
        id: "m2",
        level: "month",
        title: "Prompting, RAG, and Agent Patterns",
        summary: "Prompting, retrieval and agents.",
        len: 30,
        covers: [{ id: "aie", note: null, chapter: 5 }, { id: "aie", note: null, chapter: 6 }, { id: "agents", note: null }, { id: "rag", note: null }],
      }),
      makeNode({
        id: "m3",
        level: "month",
        title: "Production Systems and Interview Mastery",
        summary: "End-to-end systems and interview patterns.",
        len: 30,
        covers: [{ id: "aie", note: null, chapter: 10 }, { id: "prachub", note: null }, { id: "techscreen", note: null }],
      }),
    ]),
  );
}
