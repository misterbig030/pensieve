import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "u1" })) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin", () => ({ isAdmin: vi.fn(async () => false) }));
vi.mock("@/lib/ai/resolve", () => ({ resolveModels: vi.fn(async () => ({ outline: { id: "m", model: "m", keyOwner: "app" } })) }));
vi.mock("@/lib/ai/userKeyError", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/ai/userKeyError")>()),
  guardUserKeyCall: vi.fn(async (run: () => Promise<unknown>) => run()),
}));
vi.mock("@/lib/db/generationLog", () => ({ insertGenerationLog: vi.fn() }));
vi.mock("@/lib/ai/creditGate", () => ({ creditRefusal: vi.fn(async () => null) }));
vi.mock("@/lib/import/run", () => ({ runImport: vi.fn() }));
vi.mock("@/lib/ai/research/vet", () => ({ vetMaterials: vi.fn(async (materials: unknown[]) => ({ materials, dropped: [] })) }));
vi.mock("@/lib/db/queries", () => ({ createTrackWithPlan: vi.fn(async () => ({ trackId: "t1", droppedRefs: 0 })) }));

import { creditRefusal } from "@/lib/ai/creditGate";
import { UserKeyError } from "@/lib/ai/userKeyError";
import { createTrackWithPlan } from "@/lib/db/queries";
import { convertDraft } from "@/lib/import/convert";
import { WEEKLY_PLAN_DRAFT } from "@/lib/import/__fixtures__/weekly-plan.draft";
import { runImport } from "@/lib/import/run";
import { importPlanAction, confirmTrackAction } from "./actions";

const converted = convertDraft(WEEKLY_PLAN_DRAFT, "weekly-plan.md");
const file = { fileName: "weekly-plan.md", text: "# Plan\nWeek 1" };

beforeEach(() => {
  vi.mocked(runImport).mockReset();
  vi.mocked(creditRefusal).mockResolvedValue(null);
  vi.mocked(createTrackWithPlan).mockClear();
});

describe("importPlanAction", () => {
  it("rejects a .pdf", async () => {
    const result = await importPlanAction({ fileName: "plan.pdf", text: "x" });
    expect(result).toMatchObject({ ok: false, reason: "bad_file", message: "Pensieve imports .md or .txt files up to 64 KB." });
    expect(runImport).not.toHaveBeenCalled();
  });

  it("rejects empty and over-long text, and accepts an upper-case extension", async () => {
    expect(await importPlanAction({ fileName: "a.md", text: "" })).toMatchObject({ ok: false, reason: "bad_file", message: "That file is empty." });
    expect(await importPlanAction({ fileName: "a.md", text: "x".repeat(65537) })).toMatchObject({ ok: false, reason: "bad_file" });
    vi.mocked(runImport).mockResolvedValue({ result: converted, costUsd: 0 });
    expect(await importPlanAction({ fileName: "PLAN.TXT", text: "x" })).toMatchObject({ ok: true });
  });

  it("rejects whitespace-only text and malformed input as a bad file, before any model call", async () => {
    expect(await importPlanAction({ fileName: "a.md", text: "  \n\t " })).toMatchObject({ ok: false, reason: "bad_file", message: "That file is empty." });
    expect(await importPlanAction({ fileName: `${"a".repeat(253)}.md`, text: "x" })).toMatchObject({ ok: false, reason: "bad_file" });
    expect(await importPlanAction({ fileName: 7, text: "x" } as unknown as { fileName: string; text: string })).toMatchObject({ ok: false, reason: "bad_file" });
    expect(await importPlanAction(null as unknown as { fileName: string; text: string })).toMatchObject({ ok: false, reason: "bad_file" });
    expect(runImport).not.toHaveBeenCalled();
  });

  it("returns out_of_credits before any model call", async () => {
    vi.mocked(creditRefusal).mockResolvedValue(Response.json({ code: "out_of_credits", resetsAt: "2026-12-01T00:00:00.000Z" }, { status: 402 }));
    const result = await importPlanAction(file);
    expect(result).toMatchObject({ ok: false, reason: "out_of_credits", message: "You're out of free credits for now.", resetsAt: "2026-12-01T00:00:00.000Z" });
    expect(runImport).not.toHaveBeenCalled();
  });

  it("returns the plan", async () => {
    vi.mocked(runImport).mockResolvedValue({ result: converted, costUsd: 0 });
    const result = await importPlanAction(file);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.tree).toHaveLength(8);
  });

  it("returns no_plan with the converter's message", async () => {
    vi.mocked(runImport).mockResolvedValue({ result: { ok: false, reason: "no_plan", message: "Couldn't find a plan in weekly-plan.md" }, costUsd: 0 });
    expect(await importPlanAction(file)).toMatchObject({ ok: false, reason: "no_plan", message: "Couldn't find a plan in weekly-plan.md" });
  });

  it("returns too_long with the converter's message", async () => {
    vi.mocked(runImport).mockResolvedValue({ result: { ok: false, reason: "too_long", message: "too many" }, costUsd: 0 });
    expect(await importPlanAction(file)).toMatchObject({ ok: false, reason: "too_long", message: "too many" });
  });

  it("maps a UserKeyError to key with its code", async () => {
    vi.mocked(runImport).mockRejectedValue(new UserKeyError("anthropic", "invalid", "Your key was refused."));
    const result = await importPlanAction(file);
    expect(result).toMatchObject({ ok: false, reason: "key", code: "invalid", message: "Your key was refused." });
  });
});

describe("confirmTrackAction", () => {
  it("stores importText", async () => {
    if (!converted.ok) throw new Error("fixture");
    const { plan } = converted;
    await confirmTrackAction({
      topic: plan.title,
      granularity: plan.granularity,
      hoursPerWeek: plan.hoursPerWeek,
      daysPerWeek: plan.daysPerWeek,
      split: plan.split,
      materials: plan.materials,
      tree: plan.tree,
      importText: "# Plan",
    });
    expect(createTrackWithPlan).toHaveBeenCalledWith(expect.objectContaining({ importText: "# Plan" }));
  });
});
