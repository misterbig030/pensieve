import { describe, expect, it } from "vitest";
import { AVAILABLE_MODELS, DEFAULT_OUTLINE_MODEL, DEFAULT_CONTENT_MODEL } from "./models";

describe("AVAILABLE_MODELS", () => {
  it("every model id matches the provider/model gateway format", () => {
    for (const model of AVAILABLE_MODELS) {
      expect(model.id).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
    }
  });

  it("defaults point at ids present in the list", () => {
    const ids = AVAILABLE_MODELS.map((m) => m.id);
    expect(ids).toContain(DEFAULT_OUTLINE_MODEL);
    expect(ids).toContain(DEFAULT_CONTENT_MODEL);
  });
});
