/**
 * The draft eval's six criteria and its warnings, decided in code from a saved run record (the spec's criteria table).
 * Each verdict carries the ids, titles, weeks or events behind it. Nothing here calls a model or the network, so a
 * saved folder can be rescored for free.
 */
import { DEFAULT_HOURS_PER_WEEK, ROOT_ID, walk, type PlanNode } from "@/lib/planTree";
import { PRACTICE_REGISTRY, type PracticeFormat } from "@/lib/practice";
import { hostOf, type Material, type PracticeRef } from "@/lib/schemas/material";
import type { RunRecord, TimedEvent } from "./record";
import type { DraftTopic } from "./topics";

export type Verdict = { id: 1 | 2 | 3 | 4 | 5 | 6; name: string; status: "pass" | "fail" | "n/a"; evidence: string[] };

export interface Warning {
  kind: "expected-books" | "drop-reasons" | "refusal-rate" | "sizes" | "cost-time" | "retries";
  text: string;
}

const NOT_DRAFTED = "Week 1 not drafted";
/** How far a Week 1 day may plan from the daily minutes, either way. */
const DAY_TOLERANCE = 0.2;
/** Week 1 days that must name an item of the practice list. */
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

/** A reference's material and chapter: `{ id: "M1", chapter: 3 }` and `{ id: "M1.3" }` are the same chapter. */
function parseRef(ref: { id: string; chapter?: number | null }): { id: string; chapter: number | null } {
  if (ref.chapter) return { id: ref.id, chapter: ref.chapter };
  const match = ref.id.match(/^(.+)\.(\d+)$/);
  return match ? { id: match[1], chapter: Number(match[2]) } : { id: ref.id, chapter: null };
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
function plain(text: string): string {
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

function titleMatches(label: string, title: string): boolean {
  return containsWords(normalTitle(title), normalTitle(label));
}

/** The label author's surname is in the material's author; a material with no author is not held against it. */
function authorMatches(label: string, author: string | null): boolean {
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

function servedMinutes(materials: Material[], format: PracticeFormat): number {
  return materials.filter((m) => m.practice?.format === format).reduce((sum, m) => sum + practiceMinutes(m), 0);
}

const hasChapters = (m: Material | undefined) => (m?.toc?.chapters.length ?? 0) > 0;

// ---------------------------------------------------------------------------------------------------------------
// The plan's shape

interface Shape {
  weeks: PlanNode[];
  /** Week 1's days; null when Week 1 was not drafted. */
  days: PlanNode[] | null;
}

function shapeOf(plan: PlanNode | null): Shape {
  const weeks: PlanNode[] = [];
  if (plan) {
    walk(plan, (n) => {
      if (n.level === "week" && n.id !== ROOT_ID) weeks.push(n);
    });
  }
  const days = weeks[0]?.children?.filter((c) => c.level === "day") ?? [];
  return { weeks, days: days.length > 0 ? days : null };
}

const weekLabel = (i: number) => `Week ${i + 1}`;
const dayLabel = (i: number) => `Day ${i + 1}`;

/** Keys used in more than one place, with where. */
function repeats(uses: Map<string, string[]>): [string, string[]][] {
  return [...uses].map(([key, at]) => [key, [...new Set(at)]] as [string, string[]]).filter(([, at]) => at.length > 1);
}

function use(uses: Map<string, string[]>, key: string, at: string): void {
  uses.set(key, [...(uses.get(key) ?? []), at]);
}

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
  const hit = backbones.some((m) => labels.some((l) => titleMatches(l.title, m.title) && authorMatches(l.author, m.author)));
  const found = backbones.map((m) => `backbone ${m.id} "${m.title}" by ${m.author ?? "no author"}`);
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
function isNamedList(m: Material, names: string[]): boolean {
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const list = m.practice?.list;
  const haystacks = [m.title, m.url, list?.url ?? "", ...(list?.items.map((i) => i.url ?? "") ?? [])].map(compact);
  return names.map(compact).some((name) => haystacks.some((h) => h.includes(name)));
}

/**
 * The items of `lists` a practice row names: those whose title is in its task. An item position alone does not count:
 * a count-only row ("problems 1–4") can carry one and still name nothing.
 */
function itemsNamed(row: PracticeRef, lists: Material[]): { m: Material; n: number }[] {
  const task = plain(row.task);
  return lists.flatMap((m) =>
    m.practice!.list!.items.flatMap((item, i) => {
      const title = plain(item.title);
      return title.length >= 3 && containsWords(task, title) ? [{ m, n: i + 1 }] : [];
    }),
  );
}

/** 2. A read LeetCode/NeetCode list carries the problem-set time and names Week 1's problems, none twice. */
function checkNamedList(record: RunRecord, topic: DraftTopic, days: PlanNode[] | null): Verdict {
  const name = "Named practice list";
  const names = topic.labels?.practiceNames;
  if (!names?.length) return { id: 2, name, status: "n/a", evidence: [] };
  if (!days) return verdict(2, name, [NOT_DRAFTED]);
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

  const uses = new Map<string, string[]>();
  let namingDays = 0;
  days.forEach((d, i) => {
    const items = (d.practice ?? []).flatMap((row) => itemsNamed(row, named));
    if (items.length > 0) namingDays += 1;
    for (const { m, n } of items) use(uses, `"${m.practice!.list!.items[n - 1].title}" (${m.id} item ${n})`, dayLabel(i));
  });
  if (namingDays < NAMING_DAYS) failures.push(`${namingDays} of ${days.length} days name an item of the list (at least ${NAMING_DAYS})`);
  else notes.push(`${namingDays} of ${days.length} days name an item of the list`);
  for (const [item, at] of repeats(uses)) failures.push(`${item} named on ${at.join(" and ")}`);
  return verdict(2, name, failures, notes);
}

/** 3. Every material is reserved by some week, nothing with structure twice, and Week 1's days use only Week 1's. */
function checkReservations(record: RunRecord, { weeks, days }: Shape): Verdict {
  const failures: string[] = days ? [] : [NOT_DRAFTED];
  const allocated = record.materials.allocated ?? [];
  const byId = new Map(allocated.map((m) => [m.id, m]));
  const reserved = new Set<string>();
  const chapterUses = new Map<string, string[]>();
  const runs = new Map<string, { week: number; from: number; to: number }[]>();

  weeks.forEach((w, i) => {
    for (const c of w.covers ?? []) {
      const ref = parseRef(c);
      reserved.add(ref.id);
      // A review revisits what an earlier week read; a whole resource with no chapters may be shared.
      if (c.activity === "review" || (!ref.chapter && !hasChapters(byId.get(ref.id)))) continue;
      use(chapterUses, resourceKey(c), weekLabel(i));
    }
    for (const p of w.practiceCovers ?? []) {
      if (p.id === null) continue;
      const id = parseRef({ id: p.id }).id;
      reserved.add(id);
      if (p.itemFrom && p.itemTo && byId.get(id)?.practice?.list) runs.set(id, [...(runs.get(id) ?? []), { week: i, from: p.itemFrom, to: p.itemTo }]);
    }
  });

  for (const m of allocated) if (!reserved.has(m.id)) failures.push(`${m.id} "${m.title}" is reserved by no week`);
  for (const [key, at] of repeats(chapterUses)) failures.push(`${key} reserved by ${at.join(" and ")}`);
  for (const [id, list] of runs) {
    for (const [i, a] of list.entries()) {
      for (const b of list.slice(i + 1)) {
        if (a.week === b.week || Math.max(a.from, b.from) > Math.min(a.to, b.to)) continue;
        failures.push(`${id} items ${Math.max(a.from, b.from)}–${Math.min(a.to, b.to)} reserved by ${weekLabel(a.week)} and ${weekLabel(b.week)}`);
      }
    }
  }

  if (days) {
    const week = weeks[0];
    const keys = new Set((week.covers ?? []).map(resourceKey));
    const bases = new Set((week.covers ?? []).map((c) => parseRef(c).id));
    const whole = new Set((week.covers ?? []).map(parseRef).filter((r) => !r.chapter).map((r) => r.id));
    const practiceIds = new Set((week.practiceCovers ?? []).flatMap((p) => (p.id === null ? [] : [parseRef({ id: p.id }).id])));
    days.forEach((d, i) => {
      for (const r of d.materials ?? []) {
        const ref = parseRef(r);
        const ok = ref.chapter ? keys.has(resourceKey(r)) || whole.has(ref.id) : bases.has(ref.id);
        if (!ok) failures.push(`${dayLabel(i)} reads ${resourceKey(r)}, which Week 1 does not reserve`);
      }
      for (const row of d.practice ?? []) {
        const ref = rowItem(row);
        if (row.generated || !ref) continue;
        if (!practiceIds.has(ref.id) && !bases.has(ref.id)) {
          failures.push(`${dayLabel(i)} practises from ${ref.id}, which Week 1 does not reserve`);
          continue;
        }
        const weekRuns = (week.practiceCovers ?? []).filter((p) => p.id !== null && parseRef({ id: p.id }).id === ref.id);
        const ranged = weekRuns.length > 0 && weekRuns.every((p) => p.itemFrom && p.itemTo);
        if (ref.item && ranged && !weekRuns.some((p) => ref.item! >= p.itemFrom! && ref.item! <= p.itemTo!)) {
          failures.push(`${dayLabel(i)} takes ${ref.id} item ${ref.item}, outside Week 1's run`);
        }
      }
    });
  }
  return verdict(3, "Reservations add up", failures, [`${allocated.length} materials across ${weeks.length} weeks`]);
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

/** 5. Every picked format that needs a source has one, and served formats get at least half their share of practice time. */
function checkPracticeTime(record: RunRecord, topic: DraftTopic): Verdict {
  const name = "Practice time served";
  const split = record.split;
  if (!split) return { id: 5, name, status: "n/a", evidence: ["no split in the record"] };
  const { hoursPerWeek = DEFAULT_HOURS_PER_WEEK, weeks } = topic.request;
  const practice = (hoursPerWeek * weeks * 60 * (100 - split.readingShare)) / 100;
  const allocated = record.materials.allocated ?? [];
  const failures: string[] = [];
  const notes: string[] = [];
  for (const pick of split.formats ?? []) {
    if (pick.share <= 0) continue;
    const share = Math.round((practice * pick.share) / 100);
    const serving = allocated.filter((m) => m.practice?.format === pick.format);
    const served = servedMinutes(allocated, pick.format);
    if (serving.length === 0) {
      if (PRACTICE_REGISTRY[pick.format].generated === "never") failures.push(`${pick.format}: ${pick.share}% of practice (${share} min) and no material serves it`);
      else notes.push(`${pick.format}: generated (${pick.share}%)`);
    } else if (served < share / 2) {
      failures.push(`${pick.format}: materials give ${served} min against a share of ${share} min (${pick.share}%)`);
    } else notes.push(`${pick.format}: ${served} of ${share} min from ${serving.map((m) => m.id).join(", ")}`);
  }
  return verdict(5, name, failures, notes);
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

/** 6. Week 1's days fit the daily minutes, no text shows a material id, and nothing with structure is used twice. */
function checkWeekOne(record: RunRecord, topic: DraftTopic, days: PlanNode[] | null): Verdict {
  const failures: string[] = days ? [] : [NOT_DRAFTED];
  const { hoursPerWeek = DEFAULT_HOURS_PER_WEEK, daysPerWeek } = topic.request;
  const daily = (hoursPerWeek * 60) / daysPerWeek;
  const [low, high] = [daily * (1 - DAY_TOLERANCE), daily * (1 + DAY_TOLERANCE)];
  const byId = new Map((record.materials.allocated ?? []).map((m) => [m.id, m]));
  const reads = new Map<string, string[]>();
  const items = new Map<string, string[]>();
  const totals: number[] = [];

  days?.forEach((d, i) => {
    const total = (d.materials ?? []).reduce((sum, r) => sum + (r.minutes ?? 0), 0) + (d.practice ?? []).reduce((sum, r) => sum + r.minutes, 0);
    totals.push(total);
    if (total < low || total > high) failures.push(`${dayLabel(i)} plans ${total} min, outside ${Math.round(low)}–${Math.round(high)}`);
    for (const r of d.materials ?? []) {
      const ref = parseRef(r);
      if (r.activity !== "review" && (ref.chapter || hasChapters(byId.get(ref.id)))) use(reads, resourceKey(r), dayLabel(i));
    }
    for (const row of d.practice ?? []) {
      const ref = rowItem(row);
      if (ref?.item) use(items, `${ref.id} item ${ref.item}`, dayLabel(i));
    }
  });
  for (const [key, at] of repeats(reads)) failures.push(`${key} read on ${at.join(" and ")}`);
  for (const [key, at] of repeats(items)) failures.push(`${key} on ${at.join(" and ")}`);

  if (record.plan) {
    walk(record.plan, (node) => {
      if (node.id === ROOT_ID) return;
      for (const [field, text] of textsOf(node)) {
        const ids = text.match(ID_IN_TEXT);
        if (ids) failures.push(`${node.title} ${field} names ${[...new Set(ids)].join(", ")}`);
      }
    });
  }
  return verdict(6, "Week 1 days", failures, days ? [`days plan ${totals.join(", ")} min against ${Math.round(daily)}`] : []);
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

/** Calls that failed and recovered, per service (failed attempts less final failures), and levels re-asked after a breach. */
function retryWarning(record: RunRecord): Warning | null {
  const attempts = new Map<string, number>();
  const finals = new Map<string, number>();
  for (const e of record.events) {
    if (e.type !== "service" || e.ok) continue;
    const counts = e.final ? finals : attempts;
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  }
  const recovered = [...attempts].map(([name, n]) => [name, Math.max(0, n - (finals.get(name) ?? 0))] as const).filter(([, n]) => n > 0);
  const breaches = record.calls.reduce((sum, call) => sum + call.facts.filter((f) => f.startsWith("breach:")).length, 0);
  if (recovered.length === 0 && breaches === 0) return null;
  const parts = [...recovered.map(([name, n]) => `${name} ${n}`), ...(breaches > 0 ? [`breach re-asks ${breaches}`] : [])];
  return { kind: "retries", text: `recovered retries: ${parts.join(", ")}` };
}

function expectedBooksWarning(record: RunRecord, topic: DraftTopic): Warning | null {
  const expected = topic.labels?.expectedBooks;
  if (!expected?.length) return null;
  const allocated = record.materials.allocated ?? [];
  const found = expected.filter((title) => allocated.some((m) => titleMatches(title, m.title)));
  if (found.length >= Math.min(2, expected.length)) return null;
  const missing = expected.filter((title) => !found.includes(title));
  return { kind: "expected-books", text: `${found.length} of ${expected.length} expected books allocated; missing ${missing.map((t) => `"${t}"`).join(", ")}` };
}

// ---------------------------------------------------------------------------------------------------------------

export function checkRun(record: RunRecord, topic: DraftTopic): { verdicts: Verdict[]; warnings: Warning[]; passed: boolean } {
  const shape = shapeOf(record.plan);
  const verdicts = [
    checkBackbone(record, topic),
    checkNamedList(record, topic, shape.days),
    checkReservations(record, shape),
    checkServices(record),
    checkPracticeTime(record, topic),
    checkWeekOne(record, topic, shape.days),
  ];
  const warnings = [
    expectedBooksWarning(record, topic),
    dropWarning(record),
    refusalWarning(record.events),
    ...sizeWarnings(record),
    ...costTimeWarnings(record),
    retryWarning(record),
  ].filter((w): w is Warning => w !== null);
  return { verdicts, warnings, passed: verdicts.every((v) => v.status !== "fail") };
}
