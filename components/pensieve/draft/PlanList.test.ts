import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { layout, makeNode, makeRoot } from "@/lib/planTree";
import type { UnitTime } from "@/lib/schemas/plan";
import { PlanList, type PlanListProps } from "./PlanList";

const month = (id: string, summary: string, children: ReturnType<typeof makeNode>[] | null) =>
  makeNode({ id, level: "month", title: `Title ${id}`, summary, len: 4 * 5, children, covers: children ? undefined : [{ id: "aie", note: null, chapter: 3 }] });
const day = (id: string) => makeNode({ id, level: "day", title: id, summary: "", len: 1, materials: [{ id: "aie", note: null, chapter: 3, tier: "must", minutes: 30 }] });
const weekWithDays = (id: string) => makeNode({ id, level: "week", title: `Title ${id}`, summary: "", len: 5, budgetHours: 6, children: Array.from({ length: 5 }, (_, i) => day(`${id}d${i + 1}`)) });
const leafWeek = (id: string, time?: UnitTime) =>
  makeNode({ id, level: "week", title: `Title ${id}`, summary: "A week", len: 5, budgetHours: 6, materials: [{ id: "aie", note: null, chapter: 3, tier: "must", minutes: 60 }], time });

const sixMonths = layout(
  makeRoot([
    month("m1", "Month one", [leafWeek("m1w1"), leafWeek("m1w2"), leafWeek("m1w3"), leafWeek("m1w4")]),
    month("m2", "Genki I lessons 5–8", null),
    month("m3", "Genki I lessons 9–12", null),
    month("m4", "Four", null),
    month("m5", "Five", null),
    month("m6", "Six", null),
  ]),
);
const weekLeaves = layout(makeRoot([leafWeek("w1"), leafWeek("w2")]));
const plan3 = layout(makeRoot([weekWithDays("w1"), weekWithDays("w2"), weekWithDays("w3")]));
const weekWithTime = layout(makeRoot([leafWeek("w1", { reading: 150, practice: { "problem-set": 180 } })]));
const oneWeekArrived = layout(makeRoot([day("d1"), day("d2")]));

const base: PlanListProps = {
  root: sixMonths,
  materials: AIE_MATERIALS,
  hoursPerWeek: 6,
  daysPerWeek: 5,
  open: new Set(),
  weekView: new Map(),
  highlight: new Set(),
  lockBefore: 0,
  currentLeafId: null,
  pending: {},
  busy: false,
  onToggleOpen: () => {},
  onSetView: () => {},
  onExpand: () => {},
  onSplit: () => {},
};
const list = (over: Partial<PlanListProps> = {}) => renderToStaticMarkup(createElement(PlanList, { ...base, ...over })).replace(/<!-- -->/g, "");

describe("PlanList", () => {
  it("shows a closed heading's summary and that it isn't planned yet", () => {
    expect(list({ open: new Set() })).toContain("Not planned in detail yet · Genki I lessons 5–8");
  });
  it("opens a heading to what it covers and a plan button, without planning it", () => {
    const out = list({ open: new Set(["m3"]) });
    expect(out).toContain("Plan Month 3 week by week");
    expect(out).toContain("Or leave it: the plan page has the same button.");
  });
  it("has no plan button on a locked heading or while busy", () => {
    expect(list({ open: new Set(["m3"]), busy: true })).not.toContain("Plan Month 3");
    expect(list({ open: new Set(["m3"]), lockBefore: 60 })).not.toContain("Plan Month 3");
  });
  it("nests a month's weeks, each opening the same way", () => {
    const out = list({ open: new Set(["m1", "m1w2"]) });
    expect(out).toContain('data-unit="m1w2"');
    expect(out).toContain("Split into days");
  });
  it("offers a split on an open leaf week, and none on a locked one", () => {
    expect(list({ root: weekLeaves, open: new Set(["w2"]) })).toContain("Split into days");
    expect(list({ root: weekLeaves, open: new Set(["w1"]), lockBefore: 5 })).not.toContain("Split into days");
  });
  it("shows a week with days on Days by default, with the toggle", () => {
    const out = list({ root: plan3, open: new Set(["w1"]) });
    expect(out).toMatch(/aria-pressed="true"[^>]*>Days</);
  });
  it("shows the week's rows on Week", () => {
    const out = list({ root: plan3, open: new Set(["w1"]), weekView: new Map([["w1", "week" as const]]) });
    expect(out).toMatch(/aria-pressed="true"[^>]*>Week</);
    expect(out).toContain(">Read<");
  });
  it("outlines a closed row when a change touched something inside it", () => {
    const out = list({ root: plan3, open: new Set(), highlight: new Set(["w3d4"]) });
    expect(out).toMatch(/data-unit="w3"[^>]*data-changed="true"/);
  });
  it("shows a week's unit time under its title", () => {
    expect(list({ root: weekWithTime, open: new Set(["w1"]) })).toContain("2 h 30 min reading · 3 h Problems");
  });
  it("fades a locked unit and gives it no toggle", () => {
    const out = list({ root: plan3, open: new Set(["w1"]), lockBefore: 5 });
    expect(out).toContain("opacity-50");
    expect(out).not.toContain("aria-pressed");
  });
  it("draws one grey slot per pending unit", () => {
    expect(list({ root: oneWeekArrived, pending: { root: { count: 7, groups: false } } }).match(/data-slot/g)).toHaveLength(7);
  });
});
