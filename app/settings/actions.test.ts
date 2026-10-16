import { describe, expect, it } from "vitest";
import { prepareKey } from "./prepareKey";

describe("prepareKey", () => {
  it("accepts a trimmed Anthropic key", () => {
    expect(prepareKey("  sk-ant-api03-abcdef\n")).toEqual({ ok: true, provider: "anthropic", key: "sk-ant-api03-abcdef" });
  });

  it("refuses other vendors' keys and unrecognised strings with the spec's messages", () => {
    expect(prepareKey("sk-proj-abc")).toEqual({ ok: false, message: "That looks like an OpenAI key. Pensieve runs on Claude models, so it can't be used yet. Nothing was saved." });
    expect(prepareKey("AIzaSyAbc")).toEqual({ ok: false, message: "That looks like a Google key. Pensieve runs on Claude models, so it can't be used yet. Nothing was saved." });
    expect(prepareKey("hello")).toEqual({ ok: false, message: "That key isn't one Pensieve recognises. Nothing was saved." });
    expect(prepareKey("   ")).toEqual({ ok: false, message: "That key isn't one Pensieve recognises. Nothing was saved." });
  });
});
