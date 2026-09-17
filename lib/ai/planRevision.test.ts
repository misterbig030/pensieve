import { describe, expect, it } from "vitest";
import { layout, makeNode, makeRoot } from "@/lib/planTree";
import { assignRefs } from "./planPrompt";
import { applyRevision, LockedNodeError } from "./planRevision";
import { reconcileSpans } from "./planDraft";

function tree() {
  return layout(
    makeRoot([
      makeNode({
        id: "w1",
        level: "week",
        title: "Fundamentals",
        summary: "s1",
        len: 2,
        children: [
          makeNode({ id: "d1", level: "day", title: "Intro", summary: "a", len: 1, status: "completed" }),
          makeNode({ id: "d2", level: "day", title: "Metrics", summary: "b", len: 1, status: "generated" }),
        ],
      }),
      makeNode({ id: "w2", level: "week", title: "GPUs", summary: "s2", len: 7 }),
      makeNode({ id: "w3", level: "week", title: "Serving", summary: "s3", len: 7 }),
    ]),
  );
}

describe("applyRevision", () => {
  it("keeps ids and statuses for echoed refs and mints ids for new units", () => {
    const original = tree();
    const refs = assignRefs(original); // w1=n1 d1=n2 d2=n3 w2=n4 w3=n5
    const result = applyRevision(
      original,
      refs,
      {
        units: [
          { ref: "n1", title: "Fundamentals", summary: "s1", days: 2, children: [{ ref: "n2", title: "Intro", summary: "a", days: 1 }, { ref: "n3", title: "Metrics, revised", summary: "b2", days: 1 }] },
          { ref: "n5", title: "Serving", summary: "s3", days: 7 },
          { ref: "n4", title: "GPUs", summary: "s2", days: 7 },
          { title: "Mock rounds", summary: "s4", days: 7 },
        ],
      },
      0,
      "day",
    );
    expect(result.children!.map((c) => c.id)).toEqual(["w1", "w3", "w2", expect.stringMatching(/^tmp-/)]);
    expect(result.children![0].children![1].title).toBe("Metrics, revised");
    expect(result.children![0].children![1].status).toBe("generated");
    expect(result.children![0].children![0].status).toBe("completed");
    expect(result.len).toBe(23);
    expect(result.children![1].start).toBe(3);
    expect(result.children![3].level).toBe("week");
    expect(result.children![3].children).toBeNull();
  });

  it("restores locked nodes verbatim even if the model edited them", () => {
    const original = tree();
    const refs = assignRefs(original);
    const result = applyRevision(
      original,
      refs,
      {
        units: [
          { ref: "n1", title: "Fundamentals", summary: "s1", days: 2, children: [{ ref: "n2", title: "Intro CHANGED", summary: "x", days: 1 }, { ref: "n3", title: "Metrics", summary: "b", days: 1 }] },
          { ref: "n4", title: "GPUs", summary: "s2", days: 7 },
          { ref: "n5", title: "Serving", summary: "s3", days: 7 },
        ],
      },
      1,
      "day",
    );
    expect(result.children![0].children![0].title).toBe("Intro");
  });

  it("rejects a revision that drops a locked node", () => {
    const original = tree();
    const refs = assignRefs(original);
    expect(() =>
      applyRevision(
        original,
        refs,
        { units: [{ ref: "n1", title: "Fundamentals", summary: "s1", days: 1, children: [{ ref: "n3", title: "Metrics", summary: "b", days: 1 }] }, { ref: "n4", title: "GPUs", summary: "s2", days: 7 }] },
        1,
        "day",
      ),
    ).toThrow(LockedNodeError);
  });

  it("forces day units to one day and gives week leaves a budget on week plans", () => {
    const original = layout(makeRoot([makeNode({ id: "w1", level: "week", title: "A", summary: "a", len: 7, budgetHours: 6 })]));
    const refs = assignRefs(original);
    const result = applyRevision(
      original,
      refs,
      { units: [{ ref: "n1", title: "A", summary: "a", days: 7 }, { title: "B", summary: "b", days: 8 }, { title: "C", summary: "c", days: 3, children: [{ title: "C1", summary: "c1", days: 2 }] }] },
      0,
      "week",
    );
    expect(result.children![0].budgetHours).toBe(6);
    expect(result.children![1].budgetHours).toBe(7);
    expect(result.children![2].budgetHours).toBeNull();
    expect(result.children![2].children![0].len).toBe(1);
    expect(result.children![2].len).toBe(1);
  });
});

describe("reconcileSpans", () => {
  it("keeps spans when the count matches", () => {
    expect(reconcileSpans([7, 7, 8, 8], 4, "week")).toEqual([7, 7, 8, 8]);
  });
  it("re-splits the same total when the model returned a different number of weeks", () => {
    expect(reconcileSpans([7, 7, 8, 8], 5, "week")).toEqual([6, 6, 6, 6, 6]);
    expect(reconcileSpans([7, 7, 8, 8], 3, "week")).toEqual([10, 10, 10]);
  });
  it("honours the count for days", () => {
    expect(reconcileSpans([1, 1, 1, 1, 1, 1, 1], 6, "day")).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
