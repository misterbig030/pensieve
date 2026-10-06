/**
 * Golden set v2: regression records from the 2026-09-16 error analysis (evals/analysis/2026-09-16-open-coding.md).
 *
 * Each one pins an input that failed in a way code can check. They reuse the v1 inputs rather than copying them,
 * so the failing case and the capability case can never drift apart; what changes is the tag, the `why`, and for
 * wrong-edit cases an expected order. v1 stays frozen.
 */
import { GOLDEN_V1, type DraftRecord, type GoldenRecord, type ReviseRecord } from "./plan.v1";

/** Revise expectations v2 adds. Orders are node ids, so they hold in any language. */
export interface OrderExpectation {
  /** Ids of the top-level units, in the order the revised plan must have them. */
  topOrder?: string[];
  /** Ids of one heading's children, in the order they must come back. */
  childOrder?: { parentId: string; ids: string[] };
}

export type ReviseRecordV2 = Omit<ReviseRecord, "expect"> & { expect: ReviseRecord["expect"] & OrderExpectation };
export type GoldenRecordV2 = DraftRecord | ReviseRecordV2;

function v1<K extends GoldenRecord["kind"]>(id: string, kind: K): Extract<GoldenRecord, { kind: K }> {
  const record = GOLDEN_V1.find((r) => r.id === id);
  if (!record || record.kind !== kind) throw new Error(`No v1 ${kind} record "${id}"`);
  return record as Extract<GoldenRecord, { kind: K }>;
}

function draftRegression(id: string, from: string, why: string): DraftRecord {
  return { ...v1(from, "draft"), id, tag: "regression", why };
}

function reviseRegression(id: string, from: string, why: string, expect: OrderExpectation = {}): ReviseRecordV2 {
  const base = v1(from, "revise");
  return { ...base, id, tag: "regression", why, expect: { ...base.expect, ...expect } };
}

const WEEK1_DAYS = ["w1d1", "w1d2", "w1d3", "w1d4", "w1d5", "w1d6", "w1d7"];

export const GOLDEN_V2: GoldenRecordV2[] = [
  // Output language: a Chinese request answered entirely in English (9 of 48 runs).
  draftRegression(
    "reg-lang-zh-01",
    "soft-180d-week-nosrc-01-zh",
    "3 of 3 runs came back entirely in English although the topic has no Latin letters. The plan must be in Chinese.",
  ),
  draftRegression(
    "reg-lang-zh-02",
    "tech-180d-day-src-01-zh",
    "2 of 3 runs came back entirely in English despite a Chinese topic and a Chinese source title.",
  ),
  draftRegression(
    "reg-lang-zh-03",
    "tech-30d-day-offtopic-01-zh",
    "2 of 3 runs came back entirely in English; Chinese source titles did not help.",
  ),

  // Unit count: a short list that reconcileSpans turned into a shorter plan without an error.
  draftRegression(
    "reg-count-14d-zh-01",
    "creative-14d-day-nosrc-01-zh",
    "1 of 3 runs returned 6 units for 14 days and the plan silently became 6 days long. Count and length must be 14.",
  ),

  // Wrong edit: the revision is valid but is not the one that was asked for.
  reviseRegression(
    "reg-move-day-order-01",
    "rev-move-day-01",
    "3 of 3 runs put Day 3 first instead of between Day 1 and Day 2. Expected order is 1, 3, 2, then 4–7 unchanged.",
    { childOrder: { parentId: "w1", ids: ["w1d1", "w1d3", "w1d2", "w1d4", "w1d5", "w1d6", "w1d7"] } },
  ),
  reviseRegression(
    "reg-swap-weeks-order-01-zh",
    "rev-swap-weeks-01-zh",
    "5 of 5 runs swapped Weeks 2 and 4 when asked to swap Weeks 3 and 4. Expected order is w1, w2, w4, w3.",
    { topOrder: ["w1", "w2", "w4", "w3"], childOrder: { parentId: "w1", ids: WEEK1_DAYS } },
  ),

  // Locked content: 7 of 8 runs moved or duplicated completed days, or changed the plan length unasked.
  reviseRegression(
    "reg-locked-in-place-01",
    "rev-locked-week-01",
    "Completed Week 1 was moved to Day 8–14 or Day 15–21, or its days appeared twice with the same ids. It must stay at Day 1–7 with unique ids, or the revision must be refused.",
    { childOrder: { parentId: "w1", ids: WEEK1_DAYS } },
  ),
  reviseRegression(
    "reg-locked-in-place-01-zh",
    "rev-locked-week-01-zh",
    "Week 1 stayed put but the plan shrank to 28–29 days and Week 2 was expanded unasked; one run duplicated Week 1. A request that can only touch locked content must change nothing or be refused.",
    { childOrder: { parentId: "w1", ids: WEEK1_DAYS } },
  ),
];
