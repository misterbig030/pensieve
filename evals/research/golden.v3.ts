import type { Granularity } from "@/lib/planTree";
import type { SourceInput } from "@/lib/schemas/source";

/**
 * Golden set v3: briefs for comparing research arms. Mostly tech topics, where a backbone textbook and current
 * material exist, plus a few non-tech and niche ones that should come back thin. v1 stays frozen; ids follow its
 * naming so records can be traced back to it.
 *
 * Labels are optional and deliberately sparse: `expectedBackbone` only where one textbook is the clear consensus,
 * `mustInclude` only for materials a teacher of the topic would expect to see. Review them before the full run.
 */
export interface ResearchGoldenRecord {
  id: string;
  /** One line: what this record is here to catch. */
  why: string;
  input: {
    topic: string;
    days: number;
    granularity: Granularity;
    instructions?: string;
    sources: SourceInput[];
  };
  labels?: {
    expectedBackbone?: { title: string; author: string };
    mustInclude?: { title: string }[];
  };
}

export const GOLDEN_V3: ResearchGoldenRecord[] = [
  {
    id: "tech-84d-src-aieng-01",
    why: "The owner's own plan: backbone should be AI Engineering, with evals material and a learner essay kept.",
    input: {
      topic: "AI engineering: building applications on foundation models",
      days: 84,
      granularity: "week",
      instructions: "Backend engineer moving into LLM apps. About 6 hours a week, heavy on building.",
      sources: [{ url: "https://hamel.dev/blog/posts/evals/", type: "link", title: "Your AI Product Needs Evals" }],
    },
    labels: {
      expectedBackbone: { title: "AI Engineering", author: "Chip Huyen" },
      mustInclude: [{ title: "Your AI Product Needs Evals" }, { title: "Building effective agents" }],
    },
  },
  {
    id: "tech-60d-nosrc-ddia-01",
    why: "Distributed data systems have one clear backbone; checks that research finds it without help.",
    input: { topic: "Distributed data systems for backend engineers", days: 60, granularity: "week", sources: [] },
    labels: { expectedBackbone: { title: "Designing Data-Intensive Applications", author: "Martin Kleppmann" } },
  },
  {
    id: "tech-30d-nosrc-rust-01",
    why: "Official book as backbone; official docs should verify on the first try.",
    input: { topic: "Rust ownership, borrowing and lifetimes", days: 30, granularity: "day", sources: [] },
    labels: { expectedBackbone: { title: "The Rust Programming Language", author: "Steve Klabnik" } },
  },
  {
    id: "tech-90d-nosrc-ml-01",
    why: "Broad topic with several good books: recommendations must converge on one, or there is no backbone.",
    input: {
      topic: "Machine learning fundamentals with Python",
      days: 90,
      granularity: "week",
      instructions: "Comfortable with Python, rusty on linear algebra.",
      sources: [],
    },
    labels: { expectedBackbone: { title: "Hands-On Machine Learning with Scikit-Learn, Keras, and TensorFlow", author: "Aurélien Géron" } },
  },
  {
    id: "tech-14d-src-k8s-01",
    why: "Fast-moving topic with the learner's docs link: currency matters more than a book, and the link is kept.",
    input: {
      topic: "Kubernetes networking",
      days: 14,
      granularity: "day",
      sources: [{ url: "https://kubernetes.io/docs/concepts/services-networking/", type: "link" }],
    },
  },
  {
    id: "tech-7d-nosrc-sqlwin-01",
    why: "A narrow skill: docs and tutorials, no textbook expected; the plan should still pass without a backbone.",
    input: { topic: "SQL window functions", days: 7, granularity: "day", sources: [] },
  },
  {
    id: "tech-28d-src-sysdesign-01",
    why: "Interview prep with a learner book note: the note is kept, and research adds current material around it.",
    input: {
      topic: "System design interviews",
      days: 28,
      granularity: "day",
      sources: [{ url: "System Design Interview by Alex Xu", type: "note" }],
    },
  },
  {
    id: "tech-45d-nosrc-llminfra-01",
    why: "Serving and inference move fast: tests the recency share against an older backbone.",
    input: { topic: "LLM inference and serving infrastructure", days: 45, granularity: "week", sources: [] },
  },
  {
    id: "zh-30d-nosrc-csapp-01",
    why: "A Chinese brief: research should still find the English backbone (CS:APP) without falling apart.",
    input: { topic: "深入理解计算机系统", days: 30, granularity: "day", sources: [] },
    labels: { expectedBackbone: { title: "Computer Systems: A Programmer's Perspective", author: "Randal Bryant" } },
  },
  {
    id: "soft-30d-nosrc-finance-01",
    why: "Non-tech: expect a few verified materials and possibly no backbone.",
    input: { topic: "Personal finance basics", days: 30, granularity: "day", sources: [] },
  },
  {
    id: "soft-14d-nosrc-speaking-01",
    why: "Non-tech, video-heavy: kind rules for YouTube talks.",
    input: { topic: "Public speaking", days: 14, granularity: "day", sources: [] },
  },
  {
    id: "niche-21d-nosrc-whitework-01",
    why: "Deliberately thin: fewer than five verified materials and the thin notice, never an invented book.",
    input: { topic: "Victorian whitework embroidery", days: 21, granularity: "day", sources: [] },
  },
];
