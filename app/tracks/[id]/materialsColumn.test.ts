import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import type { Material } from "@/lib/schemas/material";
import { checkedShort, columnTotals } from "./materialsColumn";

const base = AIE_MATERIALS[0];
const reading = (minutes: number | null, extra: Partial<Material> = {}): Material => ({ ...base, minutes, practice: undefined, ...extra });
const practice = (minutes: number): Material => ({ ...base, minutes: null, practice: { ...(AIE_MATERIALS.find((m) => m.practice)?.practice ?? ({} as never)), minutes } });

describe("columnTotals", () => {
  it("sums reading and practice", () => {
    expect(columnTotals([reading(600), reading(420), practice(1320)])).toBe("≈ 17 h of reading · 22 h of practice");
  });

  it("names materials with no size", () => {
    expect(columnTotals([reading(600), reading(420), practice(1320), reading(null)])).toBe("≈ 17 h of reading · 22 h of practice · 1 with no size");
  });

  it("leaves out a zero part", () => {
    expect(columnTotals([reading(300)])).toBe("≈ 5 h of reading");
    expect(columnTotals([practice(300)])).toBe("≈ 5 h of practice");
  });
});

describe("checkedShort", () => {
  const research = reading(60, { origin: "research" });
  const yours = reading(60, { origin: "learner" });
  it("says whose materials they are", () => {
    expect(checkedShort([research, research])).toBe("all checked");
    expect(checkedShort([...Array(11).fill(research), yours, yours])).toBe("11 checked · 2 yours");
    expect(checkedShort([yours, yours])).toBe("2 yours");
  });
});
