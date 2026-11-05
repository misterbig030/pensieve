import type { DraftRequestBody } from "@/lib/ai/draftRequest";

/** What the checks compare a draft against, for a topic whose right answers are known. A topic without labels scores "n/a" on those criteria. */
export interface DraftTopic {
  id: string;
  request: DraftRequestBody;
  labels?: {
    /** The books a plan for this topic should be built on. */
    backbones?: { title: string; author: string }[];
    /** Names of practice lists the plan should draw its problems from. */
    practiceNames?: string[];
    /** Books the research is expected to find (a miss is a warning, not a failure). */
    expectedBooks?: string[];
  };
}

export const DRAFT_TOPICS: Record<string, DraftTopic> = {
  sde: {
    id: "sde",
    request: {
      topic: "Senior software engineer interview preparation",
      weeks: 8,
      daysPerWeek: 5,
      hoursPerWeek: 6,
      granularity: "day",
      materials: [],
    },
    labels: {
      backbones: [
        { title: "Designing Data-Intensive Applications", author: "Martin Kleppmann" },
        { title: "System Design Interview", author: "Alex Xu" },
      ],
      practiceNames: ["neetcode", "leetcode", "blind 75"],
      expectedBooks: ["Designing Data-Intensive Applications", "System Design Interview", "Cracking the Coding Interview"],
    },
  },

  // Topics from the research golden set (evals/research/golden.v3.ts), its length in days turned into weeks. They vary
  // the subject, the language and the plan's shape, so drafts reach every kind of outline call: the top level as days,
  // as week headings or leaves, or as month headings over week headings or leaves.

  // Week headings over days.
  csapp: {
    id: "csapp",
    request: { topic: "深入理解计算机系统", weeks: 4, daysPerWeek: 5, hoursPerWeek: 6, granularity: "day", materials: [] },
    labels: { backbones: [{ title: "Computer Systems: A Programmer's Perspective", author: "Randal Bryant" }] },
  },
  finance: {
    id: "finance",
    request: { topic: "Personal finance basics", weeks: 4, daysPerWeek: 5, hoursPerWeek: 6, granularity: "day", materials: [] },
  },
  // The top level as days: a one-week plan.
  sqlwin: {
    id: "sqlwin",
    request: { topic: "SQL window functions", weeks: 1, daysPerWeek: 5, hoursPerWeek: 6, granularity: "day", materials: [] },
  },
  // The top level as week leaves.
  c25k: {
    id: "c25k",
    request: { topic: "Couch to 5K", weeks: 8, daysPerWeek: 3, hoursPerWeek: 3, granularity: "week", materials: [] },
  },
  mle: {
    id: "mle",
    request: { topic: "MLE interview", weeks: 8, daysPerWeek: 5, hoursPerWeek: 8, granularity: "week", materials: [] },
  },
  // Month headings over week leaves.
  aieng: {
    id: "aieng",
    request: {
      topic: "AI engineering: building applications on foundation models",
      weeks: 12,
      daysPerWeek: 5,
      hoursPerWeek: 6,
      granularity: "week",
      instructions: "Backend engineer moving into LLM apps. About 6 hours a week, heavy on building.",
      materials: [{ url: "https://hamel.dev/blog/posts/evals/", type: "link", title: "Your AI Product Needs Evals" }],
    },
    labels: { backbones: [{ title: "AI Engineering", author: "Chip Huyen" }] },
  },
  deeplearning: {
    id: "deeplearning",
    request: {
      topic: "Deep learning from the ground up",
      weeks: 12,
      daysPerWeek: 5,
      hoursPerWeek: 30,
      granularity: "week",
      instructions: "Career change, studying full time. I want to implement things myself.",
      materials: [],
    },
  },
  // Month headings over week headings over days.
  "aieng-daily": {
    id: "aieng-daily",
    request: {
      topic: "AI engineering: building applications on foundation models",
      weeks: 12,
      daysPerWeek: 5,
      hoursPerWeek: 6,
      granularity: "day",
      instructions: "Backend engineer moving into LLM apps. About 6 hours a week, heavy on building.",
      materials: [{ url: "https://hamel.dev/blog/posts/evals/", type: "link", title: "Your AI Product Needs Evals" }],
    },
    labels: { backbones: [{ title: "AI Engineering", author: "Chip Huyen" }] },
  },
  "ml-daily": {
    id: "ml-daily",
    request: {
      topic: "Machine learning fundamentals with Python",
      weeks: 13,
      daysPerWeek: 5,
      hoursPerWeek: 6,
      granularity: "day",
      instructions: "Comfortable with Python, rusty on linear algebra.",
      materials: [],
    },
    labels: { backbones: [{ title: "Hands-On Machine Learning with Scikit-Learn, Keras, and TensorFlow", author: "Aurélien Géron" }] },
  },
  frenchrev: {
    id: "frenchrev",
    request: { topic: "The French Revolution, 1789 to 1799", weeks: 12, daysPerWeek: 5, hoursPerWeek: 6, granularity: "day", materials: [] },
  },
};
