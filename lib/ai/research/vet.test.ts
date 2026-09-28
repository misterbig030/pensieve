import { describe, expect, it, vi } from "vitest";
import type { Material } from "@/lib/schemas/material";
import { signMaterial } from "./signature";
import { SourceFetcher, type PageFetcher } from "./tools";
import { vetMaterials } from "./vet";

const SECRET = "vet-secret";

function researched(id: string, url: string, title: string, extra: Partial<Material> = {}): Material {
  const verifiedAt = "2026-09-28T10:00:00.000Z";
  return {
    id,
    origin: "research",
    type: "link",
    kind: "docs",
    url,
    title,
    author: null,
    year: null,
    why: null,
    backbone: false,
    verifiedAt,
    fetchedTitle: title,
    recommendedBy: [],
    sig: signMaterial({ url, fetchedTitle: title, verifiedAt }, SECRET),
    ...extra,
  };
}

describe("vetMaterials", () => {
  it("keeps signed materials without fetching, re-verifies forged ones, and drops those that fail", async () => {
    const fetchPage = vi.fn<PageFetcher>(async (url) => {
      if (url === "https://example.com/real") return { finalUrl: url, title: "Real guide", ogTitle: null, h1: null, author: null, published: null, text: "" };
      throw new Error("404");
    });
    const signed = researched("M1", "https://example.com/signed", "Signed guide");
    const forgedButReal = { ...researched("M2", "https://example.com/real", "Real guide"), sig: "forged" };
    const forgedAndFake = { ...researched("M3", "https://example.com/fake", "Fake guide"), sig: null };
    const result = await vetMaterials([signed, forgedButReal, forgedAndFake], {
      fetcher: new SourceFetcher(fetchPage),
      books: { find: async () => null },
      secret: SECRET,
    });
    expect(result.materials.map((m) => m.id)).toEqual(["M1", "M2"]);
    expect(result.dropped.map((m) => m.id)).toEqual(["M3"]);
    expect(result.reverified).toBe(2);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.materials[1].sig).not.toBe("forged");
  });

  it("keeps a learner's material but clears a verified claim it cannot back", async () => {
    const mine: Material = { ...researched("M1", "https://example.com/mine", "Mine"), origin: "learner", sig: "forged" };
    const result = await vetMaterials([mine], { fetcher: new SourceFetcher(async () => { throw new Error("no fetch expected"); }), books: { find: async () => null }, secret: SECRET });
    expect(result.materials[0]).toMatchObject({ id: "M1", verifiedAt: null, fetchedTitle: null });
  });

  it("keeps at most one backbone, and only a book", async () => {
    const a = researched("M1", "https://example.com/a", "A", { kind: "docs", backbone: true });
    const b = researched("M2", "https://example.com/b", "B", { kind: "book", backbone: true });
    const c = researched("M3", "https://example.com/c", "C", { kind: "book", backbone: true });
    const result = await vetMaterials([a, b, c], { fetcher: new SourceFetcher(), books: { find: async () => null }, secret: SECRET });
    expect(result.materials.map((m) => m.backbone)).toEqual([false, true, false]);
  });
});
