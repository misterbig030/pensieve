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
};
