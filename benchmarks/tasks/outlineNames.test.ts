/**
 * The judge's view and the order check name a level's units as the prompt for that call did, on the committed fixtures:
 * a top-level call, an inner heading call, a leaf call and #48's block call (the weeks of one block heading).
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { AiModelId } from "@/lib/ai/models";
import { draftLevel } from "@/lib/ai/planDraft";
import type { PlanNode } from "@/lib/planTree";
import { renderOutline } from "./outline";
import { orderBreaks } from "./outlineChecks";
import { levelInput, loadOutlineFixture, type OutlineFixture } from "./outlineFixtures";

/** The prompt the app sends for the fixture's call; the model then fails, so nothing else runs. */
async function promptOf(fixture: OutlineFixture): Promise<string> {
  let prompt = "";
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompt = options.prompt
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content)
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      throw new Error("prompt read");
    },
  });
  try {
    for await (const event of draftLevel(levelInput(fixture, { model, id: "test/model" as AiModelId, keyOwner: "app" }))) void event;
  } catch {
    // The model's refusal ends the draft once the prompt is read.
  }
  return prompt;
}

/** "Week 3" from each numbered unit line of the prompt ("1. Week 3 (5 study days) — budget about 8 h"). */
const promptNames = (prompt: string) => [...prompt.matchAll(/^\d+\. (\w+ \d+)/gm)].map((m) => m[1]);

/** The units the call asked for, empty: a level of the fixture's kind and lengths. */
function units(fixture: OutlineFixture): PlanNode[] {
  return fixture.spans.map((len, i) => ({ id: `u${i + 1}`, level: fixture.level, title: `Unit ${i + 1}`, summary: "s", len, status: "pending", budgetHours: null, manualSplit: false, children: null, start: 1, end: 1 }));
}

describe("unit names on the committed fixtures", () => {
  for (const id of ["mle-1/top", "aieng-daily-1/month-1", "aieng-daily-1/week-1", "ml-daily-1/week-1", "mle-1/weeks-3-5", "c25k-1/weeks-3-5"]) {
    it(`${id}: the judge's view and the order check name each unit as the prompt does`, async () => {
      const fixture = loadOutlineFixture(id);
      const asked = promptNames(await promptOf(fixture));
      expect(asked).toHaveLength(fixture.spans.length);

      const nodes = units(fixture);
      const view = renderOutline({ nodes, units: [], breaches: [], problems: [] }, fixture);
      const written = view.slice(view.indexOf("The level as written"));
      expect([...written.matchAll(/^(\w+ \d+): "Unit \d+"/gm)].map((m) => m[1])).toEqual(asked);

      // A chapter read after a later one, in the level's first two units, names those units as the prompt did.
      const book = fixture.materials.find((m) => (m.toc?.chapters.length ?? 0) >= 2);
      expect(book, "a material with a chapter list").toBeDefined();
      expect(nodes.length).toBeGreaterThanOrEqual(2);
      if (!book) return;
      const ref = (chapter: number) => (fixture.leaf ? { materials: [{ id: book.id, chapter, tier: "must" as const, minutes: 30, note: null }] } : { covers: [{ id: book.id, chapter, note: null }] });
      const back = [{ ...nodes[0], ...ref(2) }, { ...nodes[1], ...ref(1) }];
      const [breach] = orderBreaks(back, fixture.materials, fixture.leaf);
      expect(breach).toMatch(new RegExp(` in ${asked[1]} after .* in ${asked[0]}$`));
    });
  }

  it("names mle-1/weeks-3-5's first unit Week 1, under the block heading it plans (Month 2), as its prompt does", async () => {
    const fixture = loadOutlineFixture("mle-1/weeks-3-5");
    const prompt = await promptOf(fixture);
    expect(prompt).toMatch(/^>> Month 2 \(3 weeks\)/m);
    expect(promptNames(prompt)[0]).toBe("Week 1");
    const view = renderOutline({ nodes: units(fixture), units: [], breaches: [], problems: [] }, fixture);
    expect(view).toMatch(/^>> Month 2 \(3 weeks\)/m);
    expect(view).toMatch(/^Week 1: "Unit 1"/m);
  });
});
