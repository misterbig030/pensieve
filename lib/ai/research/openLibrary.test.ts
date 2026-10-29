import { afterEach, describe, expect, it, vi } from "vitest";
import { createPacer, isOpenLibraryHost, openLibraryPacer, openLibraryRate, OPEN_LIBRARY_PER_SECOND } from "./openLibrary";

describe("Open Library's one pace", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("counts openlibrary.org and every host under it as Open Library, and nothing else", () => {
    for (const host of ["openlibrary.org", "www.openlibrary.org", "covers.openlibrary.org", "OpenLibrary.org"]) expect(isOpenLibraryHost(host)).toBe(true);
    for (const host of ["archive.org", "evilopenlibrary.org", "openlibrary.org.example.com", "example.com"]) expect(isOpenLibraryHost(host)).toBe(false);
  });

  it("is one pacer for the whole process, the same after the module is loaded again", async () => {
    const first = openLibraryPacer();
    vi.resetModules();
    const again = await import("./openLibrary");
    expect(again.openLibraryPacer()).toBe(first);
  });

  it("goes at the identified rate while a contact is set, read at each request", () => {
    vi.stubEnv("OPEN_LIBRARY_CONTACT", "me@example.com");
    expect(openLibraryRate()).toBe(OPEN_LIBRARY_PER_SECOND.identified);
    vi.stubEnv("OPEN_LIBRARY_CONTACT", "");
    expect(openLibraryRate()).toBe(OPEN_LIBRARY_PER_SECOND.anonymous);
  });

  it("spaces requests by the rate in force when each one asks", async () => {
    let clock = 0;
    let rate = 1;
    const slept: number[] = [];
    const pace = createPacer(() => rate, () => clock, async (ms) => void slept.push(Math.round(ms)));
    await pace();
    await pace();
    expect(slept).toEqual([1000]);
    clock = 10_000;
    rate = 4;
    await Promise.all([pace(), pace()]);
    expect(slept).toEqual([1000, 250]);
  });
});
