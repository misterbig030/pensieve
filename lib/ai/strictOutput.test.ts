import { describe, expect, it } from "vitest";
import { allocationDraftSchema } from "@/lib/ai/allocate";
import { fieldMappingSchema } from "@/lib/ai/research/dataFile";
import { itemsAnswerSchema } from "@/lib/ai/research/itemFinder";
import { candidateListSchema } from "@/lib/ai/research/verify";
import { importDraftSchema } from "@/lib/import/schema";
import { dailyContentSchema } from "@/lib/schemas/dailyContent";
import { revisedTreeSchema, unitListSchema } from "@/lib/schemas/plan";
import { ANTHROPIC_MAX_OPTIONAL, ANTHROPIC_MAX_UNIONS, optionalCount, sentSchema, unionCount } from "./strictOutput";

/**
 * Every schema the app passes to `generateObject` (through `loggedGenerateObject`). A user's own Anthropic key sends
 * each as strict output, so each must stay under Anthropic's limits; the gateway key hides a breach. Add a schema here
 * when a new call sends one.
 */
const SENT_SCHEMAS = {
  allocationDraftSchema,
  candidateListSchema,
  dailyContentSchema,
  fieldMappingSchema,
  importDraftSchema,
  itemsAnswerSchema,
  revisedTreeSchema,
  unitListSchema,
};

describe("strict output limits", () => {
  it("counts every property left out of required, nested ones too", () => {
    expect(optionalCount({ type: "object", properties: { a: {}, b: { type: "object", properties: { c: {}, d: {} }, required: ["c"] } }, required: ["a"] })).toBe(2);
  });

  it("counts every union, nested ones too", () => {
    expect(unionCount({ properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] }, b: { type: ["string", "null"] } } })).toBe(2);
  });

  it.each(Object.entries(SENT_SCHEMAS))("%s stays under Anthropic's optional and union limits", (_, schema) => {
    const sent = sentSchema(schema);
    expect(optionalCount(sent)).toBeLessThanOrEqual(ANTHROPIC_MAX_OPTIONAL);
    expect(unionCount(sent)).toBeLessThanOrEqual(ANTHROPIC_MAX_UNIONS);
  });
});
