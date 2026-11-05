/**
 * The draft eval's six criteria and its warnings, decided in code from a saved run record (the spec's criteria table).
 * Each verdict carries the ids, titles, weeks or events behind it. Nothing here calls a model or the network, so a
 * saved folder can be rescored for free.
 */
import { DEFAULT_HOURS_PER_WEEK, ROOT_ID, walk, type PlanNode } from "@/lib/planTree";
import { PRACTICE_REGISTRY, type PracticeFormat } from "@/lib/practice";
import { hostOf, type Material, type PracticeRef } from "@/lib/schemas/material";
import type { PlanSplit } from "@/lib/studyTime";
import type { RunRecord, TimedEvent } from "./record";
import type { DraftTopic } from "./topics";

export type Verdict = { id: 1 | 2 | 3 | 4 | 5 | 6; name: string; status: "pass" | "fail" | "n/a"; evidence: string[] };

export interface Warning {
  kind: "expected-books" | "drop-reasons" | "refusal-rate" | "sizes" | "cost-time" | "retries" | "problems";
  text: string;
}

/** How far a first drafted unit may plan from its minutes, either way. */
const DAY_TOLERANCE = 0.2;
/** First drafted units that must name an item of the practice list. */
const NAMING_DAYS = 3;
const COST_LIMIT_USD = 2;
const TIME_LIMIT_MS = 300_000;
/** Reading rows shorter than this are a sizing slip. */
const MIN_ROW_MINUTES = 2;
/** A source with more than one unit per this many minutes of its size has too many units. */
const MINUTES_PER_UNIT = 2;
/** Item titles that are a page's link labels, not problems. */
const LABEL_TITLE = /^(?:solution|link|video|problem)s?$/i;
/** A material id as the model writes it in prose: `M9`, `M9.3`, `M4.i12`. */
const ID_IN_TEXT = /\bM\d+(?:\.i?\d+)?\b/g;

// ---------------------------------------------------------------------------------------------------------------
// References and titles

/**
 * A reference's material and chapter: `{ id: "M1", chapter: 3 }` and `{ id: "M1.3" }` are the same chapter. An item
 * suffix (`M4.i12`) names the source, not a chapter.
 */
function parseRef(ref: { id: string; chapter?: number | null }): { id: string; chapter: number | null } {
  if (ref.chapter) return { id: ref.id, chapter: ref.chapter };
  const match = ref.id.match(/^(.+)\.(i?)(\d+)$/);
  if (!match) return { id: ref.id, chapter: null };
  return { id: match[1], chapter: match[2] ? null : Number(match[3]) };
}

/** One key per chapter or whole resource, whichever way the reference writes it. */
export function resourceKey(ref: { id: string; chapter?: number | null }): string {
  const { id, chapter } = parseRef(ref);
  return chapter ? `${id}.${chapter}` : id;
}

/** A practice row's source and item: `itemFrom`, or an item written into the id (`M4.12`, `M4.i12`). */
function rowItem(row: Pick<PracticeRef, "id" | "itemFrom">): { id: string; item: number | null } | null {
  if (row.id === null) return null;
  const match = row.id.match(/^(.+)\.i?(\d+)$/);
  if (match) return { id: match[1], item: row.itemFrom ?? Number(match[2]) };
  return { id: row.id, item: row.itemFrom ?? null };
}

/** Lower case, words only. */
export function plain(text: string): string {
  return text.toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const EDITION = /\b(?:vol(?:ume)?\s*\d+|(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+edition|edition)\b/g;

/** A title without its subtitle, punctuation, volume or edition: "System Design Interview – An Insider's Guide, Vol. 2" → "system design interview". */
function normalTitle(title: string): string {
  const main = title.split(/\s*(?::|\s[-–—]\s)/)[0] ?? title;
  return plain(main).replace(EDITION, " ").replace(/\s+/g, " ").trim();
}

/** Whether `needle`'s words appear, in order, in `haystack`. */
function containsWords(haystack: string, needle: string): boolean {
  return needle !== "" && ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Whether the title is the label's book: its main title starts with the label's ("System Design Interview, Volume 2"
 * is Alex Xu's; "Machine Learning System Design Interview" only contains its words and is another book).
 */
export function titleMatches(label: string, title: string): boolean {
  const needle = normalTitle(label);
  return needle !== "" && `${normalTitle(title)} `.startsWith(`${needle} `);
}

/** A labelled book is a book: an essay titled "System design interview questions in 2026" is not Alex Xu's. */
export function bookMatches(label: string, m: Material): boolean {
  return m.kind === "book" && titleMatches(label, m.title);
}

/** The label author's surname is in the material's author; a material with no author is not held against it. */
export function authorMatches(label: string, author: string | null): boolean {
  if (!author) return true;
  return containsWords(plain(author), plain(label).split(" ").at(-1) ?? "");
}

/** A page address for comparison: no scheme, `www.`, trailing slash or fragment; a GitHub raw file as its file page. */
function urlKey(url: string): string {
  try {
    const u = new URL(url);
    let host = u.hostname.replace(/^www\./, "");
    let path = u.pathname.replace(/\/+$/, "");
    if (host === "raw.githubusercontent.com") {
      const [, owner, repo, ...rest] = path.split("/");
      host = "github.com";
      path = `/${owner}/${repo}/blob/${rest.join("/")}`;
    }
    return `${host}${path}${u.search}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function isOpenLibrary(url: string): boolean {
  const host = hostOf(url) ?? "";
  return host === "openlibrary.org" || host.endsWith(".openlibrary.org");
}

/** Minutes the allocation gives a material's practice: its minutes, else items × minutes per item. */
function practiceMinutes(m: Material): number {
  const p = m.practice;
  if (!p) return 0;
  return p.minutes ?? (p.items ?? 0) * (p.perItemMinutes ?? 0);
}

export function servedMinutes(materials: Material[], format: PracticeFormat): number {
  return materials.filter((m) => m.practice?.format === format).reduce((sum, m) => sum + practiceMinutes(m), 0);
}

/**
 * The chapter keys a reading reference takes: its chapter, or every chapter of a material it reads whole. A whole
 * resource with no chapters has no structure to overlap and takes none.
 */
function chapterKeys(ref: { id: string; chapter?: number | null }, byId: Map<string, Material>): string[] {
  const { id, chapter } = parseRef(ref);
  if (chapter) return [`${id}.${chapter}`];
  return (byId.get(id)?.toc?.chapters ?? []).map((_, i) => `${id}.${i + 1}`);
}

const hasChapters = (m: Material | undefined) => (m?.toc?.chapters.length ?? 0) > 0;

// ---------------------------------------------------------------------------------------------------------------
// The plan's shape

/** A reading reference, a heading's cover or a leaf's Read row. */
type ReadRef = { id: string; chapter?: number | null; note?: string | null; activity?: string };

/** A unit of the plan with its label: "Month 2" at the top, "Day 3" inside its group. */
interface Unit {
  node: PlanNode;
  label: string;
}

/** The first drafted run of leaves: Week 1's days, Month 1's weeks, or the top level when its units are leaves. */
interface LeafGroup {
  /** The heading the leaves were planned inside; null when they are the top level. */
  parent: Unit | null;
  units: Unit[];
  /** "Week 1 days", "Month 1 weeks", "Days". */
  name: string;
  noun: string;
}

interface Shape {
  /** The top-level units, which hold the plan's reservations whatever their level. */
  top: Unit[];
  /** Whether the top-level units are leaves (a week of days, or a plan of week leaves). */
  topLeaves: boolean;
  topNoun: string;
  group: LeafGroup | null;
  /** Why there is no group: no plan, or the first unit was not drafted. */
  missing: string;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const unitLabel = (node: PlanNode, i: number) => `${capitalize(node.level)} ${i + 1}`;

/**
 * The plan's top level and its first drafted leaf group. A leaf is a day, or a week when the plan is planned in weeks;
 * a heading's leaves are the children it was split into, so the first heading in order with leaf children is the
 * first one drafted.
 */
function shapeOf(plan: PlanNode | null, granularity: "day" | "week"): Shape {
  const isLeaf = (n: PlanNode) => n.level === "day" || (n.level === "week" && granularity === "week");
  const leafNoun = granularity;
  if (!plan) return { top: [], topLeaves: false, topNoun: "unit", group: null, missing: "no plan in the record" };
  const top = (plan.children ?? []).map((node, i) => ({ node, label: unitLabel(node, i) }));
  const topNoun = top[0]?.node.level ?? "unit";
  const topLeaves = top.length > 0 && top.every((u) => isLeaf(u.node));
  const groupOf = (parent: Unit | null, children: PlanNode[]): LeafGroup => ({
    parent,
    units: children.map((node, i) => ({ node, label: unitLabel(node, i) })),
    name: parent ? `${parent.label} ${leafNoun}s` : `${capitalize(leafNoun)}s`,
    noun: leafNoun,
  });
  if (topLeaves) return { top, topLeaves, topNoun, group: groupOf(null, top.map((u) => u.node)), missing: "" };

  const find = (units: Unit[]): LeafGroup | null => {
    for (const unit of units) {
      const children = unit.node.children ?? [];
      const leaves = children.filter(isLeaf);
      if (leaves.length > 0) return groupOf(unit, leaves);
      const found = find(children.map((node, i) => ({ node, label: `${unit.label} · ${unitLabel(node, i)}` })));
      if (found) return found;
    }
    return null;
  };
  const group = find(top);
  return { top, topLeaves, topNoun, group, missing: group ? "" : top[0] ? `${top[0].label} not drafted` : "the plan has no units" };
}

/** Where a reference or row is used: the unit's position and whether it names its part in a note. */
type Use = { at: number; noted: boolean };

function use(uses: Map<string, Use[]>, key: string, at: number, note?: string | null): void {
  uses.set(key, [...(uses.get(key) ?? []), { at, noted: !!note?.trim() }]);
}

/**
 * Keys used in more than one unit, with the units' labels and why that is not allowed. With `spans`, a chapter longer
 * than one unit may run across consecutive units when each names its part in a note (the leaf rules); otherwise any
 * second unit is a repeat.
 */
function repeats(uses: Map<string, Use[]>, labels: string[], spans = false): { key: string; at: string; why: string }[] {
  const out: { key: string; at: string; why: string }[] = [];
  for (const [key, list] of uses) {
    const at = [...new Set(list.map((u) => u.at))].sort((a, b) => a - b);
    if (at.length < 2) continue;
    const where = at.map((i) => labels[i]).join(" and ");
    if (!spans) {
      out.push({ key, at: where, why: "" });
      continue;
    }
    const consecutive = at.every((i, n) => n === 0 || i === at[n - 1] + 1);
    if (!consecutive) out.push({ key, at: where, why: "not in consecutive units" });
    else if (!list.every((u) => u.noted)) out.push({ key, at: where, why: "without the part in a note" });
  }
  return out;
}

const withWhy = (text: string, why: string) => (why ? `${text}, ${why}` : text);

function verdict(id: Verdict["id"], name: string, failures: string[], notes: string[] = []): Verdict {
  return { id, name, status: failures.length > 0 ? "fail" : "pass", evidence: [...failures, ...notes] };
}

// ---------------------------------------------------------------------------------------------------------------
// The criteria

/** 1. The allocated backbone is one of the label's backbones, by title and author. */
function checkBackbone(record: RunRecord, topic: DraftTopic): Verdict {
  const name = "Backbone";
  const labels = topic.labels?.backbones;
  if (!labels?.length) return { id: 1, name, status: "n/a", evidence: [] };
  const backbones = (record.materials.allocated ?? []).filter((m) => m.backbone);
  if (backbones.length === 0) return verdict(1, name, [record.materials.allocated ? "no backbone allocated" : "no allocation in the record"]);
  const hit = backbones.some((m) => labels.some((l) => bookMatches(l.title, m) && authorMatches(l.author, m.author)));
  const found = backbones.map((m) => `backbone ${m.id} "${m.title}" (${m.kind}) by ${m.author ?? "no author"}`);
  return hit ? verdict(1, name, [], found) : verdict(1, name, [...found, `expected one of: ${labels.map((l) => `"${l.title}" (${l.author})`).join(", ")}`]);
}

/** Whether a list's page or file was read: a successful page read, or a structure finder that took items from it. */
function wasRead(url: string, events: TimedEvent[]): boolean {
  const key = urlKey(url);
  return events.some(
    (e) => (e.type === "research.fetch" && e.ok && urlKey(e.url) === key) || (e.type === "research.structure" && e.items > 0 && !!e.url && urlKey(e.url) === key),
  );
}

/** Whether a practice source is one of the named lists, by title, address, list address or item links. */
export function isNamedList(m: Material, names: string[]): boolean {
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const list = m.practice?.list;
  const haystacks = [m.title, m.url, list?.url ?? "", ...(list?.items.map((i) => i.url ?? "") ?? [])].map(compact);
  return names.map(compact).some((name) => haystacks.some((h) => h.includes(name)));
}

/**
 * The items of `lists` a practice row names: those whose title is in its task, longest titles only. An item position
 * alone does not count: a count-only row ("problems 1–4") can carry one and still name nothing.
 */
function itemsNamed(row: PracticeRef, lists: Material[]): { m: Material; n: number }[] {
  const task = plain(row.task);
  const found = lists.flatMap((m) =>
    m.practice!.list!.items.flatMap((item, i) => {
      const title = plain(item.title);
      return title.length >= 3 && containsWords(task, title) ? [{ m, n: i + 1, title }] : [];
    }),
  );
  // "Two Sum II – Input Array Is Sorted" names that item, not "Two Sum" as well.
  return found.filter((a) => !found.some((b) => b.title !== a.title && containsWords(b.title, a.title))).map(({ m, n }) => ({ m, n }));
}

/** 2. A read LeetCode/NeetCode list carries the problem-set time and names the first leaves' problems, none twice. */
function checkNamedList(record: RunRecord, topic: DraftTopic, { group, missing }: Shape): Verdict {
  const name = "Named practice list";
  const names = topic.labels?.practiceNames;
  if (!names?.length) return { id: 2, name, status: "n/a", evidence: [] };
  if (!group) return verdict(2, name, [missing]);
  const allocated = record.materials.allocated ?? [];
  const lists = allocated.filter((m) => m.practice?.format === "problem-set" && m.practice.list);
  if (lists.length === 0) return verdict(2, name, ["no problem set carries an item list"]);

  const notes: string[] = [];
  const named: Material[] = [];
  for (const m of lists) {
    const url = m.practice!.list!.url;
    if (!isNamedList(m, names)) notes.push(`${m.id} "${m.title}" is not ${names.join(", ")}`);
    else if (!wasRead(url, record.events)) notes.push(`${m.id} "${m.title}": its list at ${url} was never read`);
    else {
      named.push(m);
      notes.push(`${m.id} "${m.title}": ${m.practice!.list!.items.length} items read from ${url}`);
    }
  }
  if (named.length === 0) return verdict(2, name, [`no read ${names.join("/")} list`, ...notes]);

  const failures: string[] = [];
  const total = servedMinutes(allocated, "problem-set");
  const fromLists = named.reduce((sum, m) => sum + practiceMinutes(m), 0);
  if (fromLists === 0 || fromLists < total / 2) failures.push(`the lists give ${fromLists} of the plan's ${total} problem-set minutes`);

  const uses = new Map<string, Use[]>();
  let naming = 0;
  group.units.forEach(({ node }, i) => {
    const items = (node.practice ?? []).flatMap((row) => itemsNamed(row, named));
    if (items.length > 0) naming += 1;
    for (const { m, n } of items) use(uses, `"${m.practice!.list!.items[n - 1].title}" (${m.id} item ${n})`, i);
  });
  const count = `${naming} of ${group.units.length} ${group.noun}s name an item of the list`;
  if (naming < NAMING_DAYS) failures.push(`${count} (at least ${NAMING_DAYS})`);
  else notes.push(count);
  for (const { key, at } of repeats(uses, group.units.map((u) => u.label))) failures.push(`${key} named on ${at}`);
  return verdict(2, name, failures, notes);
}

/**
 * What a top-level unit reserves: a heading its covers and practice covers; a leaf, planned in full, what it reads and
 * practises. Practice comes back as a source id and, for an item run, its range.
 */
function reservationsOf(node: PlanNode, leaf: boolean): { reads: ReadRef[]; practice: { id: string; from: number | null; to: number | null }[] } {
  if (!leaf) {
    return {
      reads: node.covers ?? [],
      practice: (node.practiceCovers ?? []).flatMap((p) => (p.id === null ? [] : [{ id: parseRef({ id: p.id }).id, from: p.itemFrom ?? null, to: p.itemTo ?? null }])),
    };
  }
  return {
    reads: node.materials ?? [],
    practice: (node.practice ?? []).flatMap((row) => {
      const ref = rowItem(row);
      if (row.generated || !ref) return [];
      return [{ id: ref.id, from: row.itemFrom ?? ref.item, to: row.itemTo ?? row.itemFrom ?? ref.item }];
    }),
  };
}

/**
 * 3. Every material is reserved by some top-level unit, nothing with structure twice (a leaf may run a chapter across
 * consecutive units, naming its part), and the first drafted leaves use only what their heading reserves.
 */
function checkReservations(record: RunRecord, { top, topLeaves, topNoun, group, missing }: Shape): Verdict {
  const name = "Reservations add up";
  if (top.length === 0) return verdict(3, name, [missing]);
  const failures: string[] = group ? [] : [missing];
  const allocated = record.materials.allocated ?? [];
  const byId = new Map(allocated.map((m) => [m.id, m]));
  const labels = top.map((u) => u.label);
  const reserved = new Set<string>();
  const chapterUses = new Map<string, Use[]>();
  const runs = new Map<string, { at: number; from: number; to: number }[]>();

  top.forEach(({ node }, i) => {
    const { reads, practice } = reservationsOf(node, topLeaves);
    for (const c of reads) {
      reserved.add(parseRef(c).id);
      // A review revisits what an earlier unit read.
      if (c.activity !== "review") for (const key of chapterKeys(c, byId)) use(chapterUses, key, i, c.note);
    }
    for (const p of practice) {
      reserved.add(p.id);
      if (p.from && p.to && byId.get(p.id)?.practice?.list) runs.set(p.id, [...(runs.get(p.id) ?? []), { at: i, from: p.from, to: p.to }]);
    }
  });

  for (const m of allocated) if (!reserved.has(m.id)) failures.push(`${m.id} "${m.title}" is reserved by no ${topNoun}`);
  for (const { key, at, why } of repeats(chapterUses, labels, topLeaves)) failures.push(withWhy(`${key} reserved by ${at}`, why));
  for (const [id, list] of runs) {
    for (const [i, a] of list.entries()) {
      for (const b of list.slice(i + 1)) {
        if (a.at === b.at || Math.max(a.from, b.from) > Math.min(a.to, b.to)) continue;
        failures.push(`${id} items ${Math.max(a.from, b.from)}–${Math.min(a.to, b.to)} reserved by ${labels[a.at]} and ${labels[b.at]}`);
      }
    }
  }

  // Leaves at the top level reserve for themselves; leaves under a heading use only the heading's reservation.
  const parent = group?.parent;
  if (group && parent) {
    const covers = parent.node.covers ?? [];
    const practiceCovers = parent.node.practiceCovers ?? [];
    const keys = new Set(covers.map(resourceKey));
    const bases = new Set(covers.map((c) => parseRef(c).id));
    const whole = new Set(covers.map(parseRef).filter((r) => !r.chapter).map((r) => r.id));
    const practiceIds = new Set(practiceCovers.flatMap((p) => (p.id === null ? [] : [parseRef({ id: p.id }).id])));
    for (const { node, label } of group.units) {
      for (const r of node.materials ?? []) {
        const ref = parseRef(r);
        // A whole read of a chaptered material needs the whole of it; of one with no chapters, any cover of it.
        const ok = ref.chapter ? keys.has(resourceKey(r)) || whole.has(ref.id) : hasChapters(byId.get(ref.id)) ? whole.has(ref.id) : bases.has(ref.id);
        if (!ok) failures.push(`${label} reads ${resourceKey(r)}, which ${parent.label} does not reserve`);
      }
      for (const row of node.practice ?? []) {
        const ref = rowItem(row);
        if (row.generated || !ref) continue;
        if (!practiceIds.has(ref.id) && !bases.has(ref.id)) {
          failures.push(`${label} practises from ${ref.id}, which ${parent.label} does not reserve`);
          continue;
        }
        const parentRuns = practiceCovers.filter((p) => p.id !== null && parseRef({ id: p.id }).id === ref.id);
        const ranged = parentRuns.length > 0 && parentRuns.every((p) => p.itemFrom && p.itemTo);
        if (ref.item && ranged && !parentRuns.some((p) => ref.item! >= p.itemFrom! && ref.item! <= p.itemTo!)) {
          failures.push(`${label} takes ${ref.id} item ${ref.item}, outside ${parent.label}'s run`);
        }
      }
    }
  }
  return verdict(3, name, failures, [`${allocated.length} materials across ${top.length} ${topNoun}s`]);
}

/** 4. No outside call ended without an answer, no Open Library read failed, and the stream did not error. */
function checkServices(record: RunRecord): Verdict {
  const failures: string[] = [];
  for (const e of record.events) {
    if (e.type === "service" && !e.ok && e.final) {
      failures.push(`${e.name} failed${e.status ? ` (${e.status})` : ""}${e.where ? ` at ${e.where}` : ""}${e.reason ? `: ${e.reason}` : ""}`);
    } else if (e.type === "error") failures.push(`error: ${e.message}`);
    else if (e.type === "research.fetch" && !e.ok && isOpenLibrary(e.url)) failures.push(`Open Library read failed: ${e.url}${e.reason ? ` (${e.reason})` : ""}`);
  }
  return verdict(4, "Outside services", failures, failures.length === 0 ? ["no failed service call"] : []);
}

/** The request the run drafted; a folder saved before runs recorded it is judged by the topic's. */
function requestOf(record: RunRecord, topic: DraftTopic): DraftTopic["request"] {
  return record.meta.request ?? topic.request;
}

/**
 * What a split's practice share asks of the materials: the picked formats that cannot be generated and have no serving
 * material (`unserved`), the served ones that get under half their share of minutes (`short`), and a note for each of
 * the rest.
 */
export function practiceTimeFindings(
  split: PlanSplit,
  materials: Material[],
  { weeks, hoursPerWeek = DEFAULT_HOURS_PER_WEEK }: { weeks: number; hoursPerWeek?: number },
): { unserved: string[]; short: string[]; notes: string[] } {
  const practice = (hoursPerWeek * weeks * 60 * (100 - split.readingShare)) / 100;
  const unserved: string[] = [];
  const short: string[] = [];
  const notes: string[] = [];
  for (const pick of split.formats ?? []) {
    if (pick.share <= 0) continue;
    const share = Math.round((practice * pick.share) / 100);
    const serving = materials.filter((m) => m.practice?.format === pick.format);
    const served = servedMinutes(materials, pick.format);
    if (serving.length === 0) {
      if (PRACTICE_REGISTRY[pick.format].generated === "never") unserved.push(`${pick.format}: ${pick.share}% of practice (${share} min) and no material serves it`);
      else notes.push(`${pick.format}: generated (${pick.share}%)`);
    } else if (served < share / 2) {
      short.push(`${pick.format}: materials give ${served} min against a share of ${share} min (${pick.share}%)`);
    } else notes.push(`${pick.format}: ${served} of ${share} min from ${serving.map((m) => m.id).join(", ")}`);
  }
  return { unserved, short, notes };
}

/** 5. Every picked format that needs a source has one, and served formats get at least half their share of practice time. */
function checkPracticeTime(record: RunRecord, topic: DraftTopic): Verdict {
  const name = "Practice time served";
  const split = record.split;
  if (!split) return { id: 5, name, status: "n/a", evidence: ["no split in the record"] };
  const { unserved, short, notes } = practiceTimeFindings(split, record.materials.allocated ?? [], requestOf(record, topic));
  return verdict(5, name, [...unserved, ...short], notes);
}

/** Every piece of text a plan node shows, with where it is. */
function textsOf(node: PlanNode): [string, string][] {
  return [
    ["title", node.title],
    ["summary", node.summary],
    ...(node.covers ?? []).map((c) => ["note", c.note ?? ""] as [string, string]),
    ...(node.materials ?? []).map((r) => ["note", r.note ?? ""] as [string, string]),
    ...(node.practiceCovers ?? []).flatMap((p) => [["note", p.note ?? ""], ["task", p.task ?? ""]] as [string, string][]),
    ...(node.practice ?? []).map((r) => ["task", r.task] as [string, string]),
  ];
}

/** A leaf's minutes: its own hours when the outline gave it some, else a day's share of the week or the week's. */
function leafBudget(node: PlanNode, { hoursPerWeek, daysPerWeek }: { hoursPerWeek: number; daysPerWeek: number }): number {
  if (node.budgetHours) return node.budgetHours * 60;
  return node.level === "day" ? (hoursPerWeek * 60) / daysPerWeek : hoursPerWeek * 60;
}

/**
 * 6. The first drafted leaves (Week 1's days, Month 1's weeks, or the top level's) fit their minutes, nothing with
 * structure is used twice (a chapter may run across consecutive units, naming its part), and no text shows a material id.
 */
function checkFirstLeaves(record: RunRecord, topic: DraftTopic, { group, missing }: Shape): Verdict {
  const failures: string[] = group ? [] : [missing];
  const { hoursPerWeek = DEFAULT_HOURS_PER_WEEK, daysPerWeek } = requestOf(record, topic);
  const byId = new Map((record.materials.allocated ?? []).map((m) => [m.id, m]));
  const reads = new Map<string, Use[]>();
  const items = new Map<string, Use[]>();
  const totals: number[] = [];
  const budgets = new Set<number>();
  const units = group?.units ?? [];

  units.forEach(({ node, label }, i) => {
    const budget = leafBudget(node, { hoursPerWeek, daysPerWeek });
    const [low, high] = [budget * (1 - DAY_TOLERANCE), budget * (1 + DAY_TOLERANCE)];
    budgets.add(Math.round(budget));
    const total = (node.materials ?? []).reduce((sum, r) => sum + (r.minutes ?? 0), 0) + (node.practice ?? []).reduce((sum, r) => sum + r.minutes, 0);
    totals.push(total);
    if (total < low || total > high) failures.push(`${label} plans ${total} min, outside ${Math.round(low)}–${Math.round(high)}`);
    for (const r of node.materials ?? []) if (r.activity !== "review") for (const key of chapterKeys(r, byId)) use(reads, key, i, r.note);
    for (const row of node.practice ?? []) {
      const ref = rowItem(row);
      if (ref?.item) use(items, `${ref.id} item ${ref.item}`, i);
    }
  });
  const labels = units.map((u) => u.label);
  for (const { key, at, why } of repeats(reads, labels, true)) failures.push(withWhy(`${key} read on ${at}`, why));
  for (const { key, at } of repeats(items, labels)) failures.push(`${key} on ${at}`);

  if (record.plan) {
    walk(record.plan, (node) => {
      if (node.id === ROOT_ID) return;
      for (const [field, text] of textsOf(node)) {
        const ids = text.match(ID_IN_TEXT);
        if (ids) failures.push(`${node.title} ${field} names ${[...new Set(ids)].join(", ")}`);
      }
    });
  }
  return verdict(6, "First drafted units", failures, group ? [`${group.name} plan ${totals.join(", ")} min against ${[...budgets].join("/")}`] : []);
}

// ---------------------------------------------------------------------------------------------------------------
// Warnings

const DROP_KINDS: [string, RegExp][] = [
  ["no author", /author/i],
  ["outage", /unavailable|outage|timed out|\b5\d\d\b|network|econn/i],
  ["no match", /no match|doesn't match|does not match|not found/i],
  ["page refused", /\b(?:401|403|429)\b|refused|blocked|forbidden|script/i],
];

function dropWarning(record: RunRecord): Warning | null {
  const drops = new Map<string, string>();
  for (const e of record.events) if (e.type === "research.dropped") drops.set(`${e.title}\n${e.reason}`, e.reason);
  for (const d of record.materials.dropped) drops.set(`${d.title}\n${d.reason}`, d.reason);
  if (drops.size === 0) return null;
  const counts = new Map<string, number>();
  for (const reason of drops.values()) {
    const kind = DROP_KINDS.find(([, pattern]) => pattern.test(reason))?.[0] ?? "other";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const order = [...DROP_KINDS.map(([kind]) => kind), "other"].filter((kind) => counts.has(kind));
  return { kind: "drop-reasons", text: `${drops.size} dropped: ${order.map((kind) => `${kind} ${counts.get(kind)}`).join(", ")}` };
}

function refusalWarning(events: TimedEvent[]): Warning | null {
  const fetches = events.filter((e) => e.type === "research.fetch");
  const refused = fetches.filter((e) => !e.ok && !isOpenLibrary(e.url));
  if (refused.length === 0) return null;
  const hosts = new Map<string, number>();
  for (const e of refused) hosts.set(hostOf(e.url) ?? e.url, (hosts.get(hostOf(e.url) ?? e.url) ?? 0) + 1);
  const rate = Math.round((refused.length / fetches.length) * 100);
  return { kind: "refusal-rate", text: `${refused.length} of ${fetches.length} page reads refused (${rate}%): ${[...hosts].map(([h, n]) => `${h} ×${n}`).join(", ")}` };
}

function sizeWarnings(record: RunRecord): Warning[] {
  const texts: string[] = [];
  const short: string[] = [];
  if (record.plan) {
    walk(record.plan, (node) => {
      for (const r of node.materials ?? []) if (r.minutes !== null && r.minutes < MIN_ROW_MINUTES) short.push(`${node.title}: ${resourceKey(r)} ${r.minutes} min`);
    });
  }
  if (short.length > 0) texts.push(`${short.length} reading rows under ${MIN_ROW_MINUTES} min (${short.join("; ")})`);
  for (const m of record.materials.allocated ?? []) {
    const units = m.toc?.chapters.length ?? 0;
    if (units > 0 && m.minutes && units > m.minutes / MINUTES_PER_UNIT) texts.push(`${m.id} "${m.title}" has ${units} units in ${m.minutes} min`);
    const labels = (m.practice?.list?.items ?? []).flatMap((item, i) => (LABEL_TITLE.test(item.title.trim()) ? [`${i + 1} "${item.title}"`] : []));
    if (labels.length > 0) texts.push(`${m.id} items titled as labels: ${labels.join(", ")}`);
  }
  const structure = record.events.filter((e) => e.type === "research.structure");
  const refused = structure.filter((e) => e.refused);
  if (refused.length > 0) texts.push(`${refused.length} of ${structure.length} structure answers refused`);
  return texts.map((text) => ({ kind: "sizes", text }));
}

function costTimeWarnings(record: RunRecord): Warning[] {
  const { costUsd, ms } = record.meta;
  const out: Warning[] = [];
  if (costUsd > COST_LIMIT_USD) out.push({ kind: "cost-time", text: `cost $${costUsd.toFixed(2)}, over $${COST_LIMIT_USD}` });
  if (ms > TIME_LIMIT_MS) out.push({ kind: "cost-time", text: `took ${Math.round(ms / 1000)} s, over ${TIME_LIMIT_MS / 1000} s` });
  return out;
}

/** Per service, the failed attempts and the calls that gave up. */
function retryWarning(record: RunRecord): Warning | null {
  const counts = new Map<string, { attempts: number; finals: number }>();
  for (const e of record.events) {
    if (e.type !== "service" || e.ok) continue;
    const c = counts.get(e.name) ?? { attempts: 0, finals: 0 };
    if (e.final) c.finals += 1;
    else c.attempts += 1;
    counts.set(e.name, c);
  }
  if (counts.size === 0) return null;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [...counts].map(([name, c]) => `${name}: ${plural(c.attempts, "failed attempt")}, ${plural(c.finals, "call")} gave up`);
  return { kind: "retries", text: parts.join("; ") };
}

/** The rule breaks the checks reported to the learner as problems (`breach:` facts); the draft keeps them as written. */
function problemsWarning(record: RunRecord): Warning | null {
  const reported = record.calls.reduce((sum, call) => sum + call.facts.filter((f) => f.startsWith("breach:")).length, 0);
  return reported > 0 ? { kind: "problems", text: `reported problems: ${reported}` } : null;
}

function expectedBooksWarning(record: RunRecord, topic: DraftTopic): Warning | null {
  const expected = topic.labels?.expectedBooks;
  if (!expected?.length) return null;
  const allocated = record.materials.allocated ?? [];
  const found = expected.filter((title) => allocated.some((m) => bookMatches(title, m)));
  if (found.length >= Math.min(2, expected.length)) return null;
  const missing = expected.filter((title) => !found.includes(title));
  return { kind: "expected-books", text: `${found.length} of ${expected.length} expected books allocated; missing ${missing.map((t) => `"${t}"`).join(", ")}` };
}

// ---------------------------------------------------------------------------------------------------------------

export function checkRun(record: RunRecord, topic: DraftTopic): { verdicts: Verdict[]; warnings: Warning[]; passed: boolean } {
  const shape = shapeOf(record.plan, requestOf(record, topic).granularity);
  const verdicts = [
    checkBackbone(record, topic),
    checkNamedList(record, topic, shape),
    checkReservations(record, shape),
    checkServices(record),
    checkPracticeTime(record, topic),
    checkFirstLeaves(record, topic, shape),
  ];
  const warnings = [
    expectedBooksWarning(record, topic),
    dropWarning(record),
    refusalWarning(record.events),
    ...sizeWarnings(record),
    ...costTimeWarnings(record),
    retryWarning(record),
    problemsWarning(record),
  ].filter((w): w is Warning => w !== null);
  return { verdicts, warnings, passed: verdicts.every((v) => v.status !== "fail") };
}
