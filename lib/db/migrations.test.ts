import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// Drizzle's migrator applies only the migrations whose `when` is later than the last one applied, and skips the rest
// without a word. The production build migrates on its own, so a journal out of order would deploy a migration that
// never runs: after hand-resolving a journal conflict between two branches, say.
const dir = path.resolve(__dirname, "../../drizzle");
const journal = JSON.parse(readFileSync(path.join(dir, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

describe("the migration journal", () => {
  it("numbers its entries 0, 1, 2… with tags to match", () => {
    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      expect(entry.tag.startsWith(`${String(i).padStart(4, "0")}_`)).toBe(true);
    });
  });

  it("dates every entry after the one before it", () => {
    for (let i = 1; i < journal.entries.length; i += 1) {
      const [before, entry] = [journal.entries[i - 1], journal.entries[i]];
      expect(entry.when, `${entry.tag} is dated before ${before.tag}, so Drizzle would skip it`).toBeGreaterThan(before.when);
    }
  });

  it("lists every migration file, and only files that exist", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(journal.entries.map((e) => `${e.tag}.sql`)).toEqual(files);
  });
});
