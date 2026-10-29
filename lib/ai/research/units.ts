import { z } from "zod";
import {
  MAX_CHAPTERS,
  MAX_HEADING,
  MAX_SECTIONS,
  MIN_CHAPTERS,
  chapterListSchema,
  clip,
  type Chapter,
  type ChapterList,
  type Material,
  type MinutesBasis,
  type PracticeList,
} from "@/lib/schemas/material";
import { SECTION_SKIP_RE, withChapterSizes } from "./chapters";
import { MAX_UNSEEN_SHARE, itemNumber, normalText, validateItemList, type ItemDraft } from "./itemFinder";
import type { OutlineHeading, OutlineLink, PageOutline } from "./outline";
import { MIN_MEASURED_WORDS, WORDS_PER_MINUTE, canonicalUrl } from "./verify";

/**
 * The check on a structure finder's answer, before anything is saved. Pure code: every unit must point at a page a
 * finder tool returned (or a heading on one), every title must be on that page, and every size comes from what the
 * tools measured. The model's own minutes survive only for a unit whose page could not be measured.
 */

/** Heading units on one page must cover at least this share of its words, or they are a sample, not the source. */
export const MIN_UNIT_COVERAGE = 0.7;

/** What the source is to the plan: reading, practice, or both. It decides which units count. */
export type StructureRole = "read" | "practice" | "both";

export const structureAnswerSchema = z.object({
  note: z.string(),
  whole: z.boolean(),
  units: z.array(z.object({ title: z.string(), at: z.string(), kind: z.enum(["read", "practice"]), group: z.string().nullable(), minutes: z.number().nullable() })),
  listUrl: z.string().nullable(),
});
export type StructureAnswer = z.infer<typeof structureAnswerSchema>;

/** A page a finder tool returned: what the unit check may point at. */
export interface SeenPage {
  url: string;
  finalUrl: string;
  title: string | null;
  words: number | null;
  durationMinutes: number | null;
  pdfPages: number | null;
  outline: PageOutline | null;
  text: string;
}

export interface UnitsVerdict {
  /** Reading units, source "page". */
  toc: ChapterList | null;
  /** New size; null = leave the material's size as it is. */
  minutes: number | null;
  basis: MinutesBasis | null;
  /** Practice units saved as an item list, or the `items` tool's list. */
  list: PracticeList | null;
  /** Why the units were refused ("units refused: 4 of 22 titles not on the page"); null when they were not. */
  refused: string | null;
  facts: string[];
}

const MAX_MINUTES = 60_000;
const MAX_ITEM_MINUTES = 600;

type Unit = StructureAnswer["units"][number];
type UnitKind = Unit["kind"];

const ROLE_KINDS: Record<StructureRole, UnitKind[]> = { read: ["read"], practice: ["practice"], both: ["read", "practice"] };

/** A unit that points at something fetched, with what it points at and its size. */
interface Placed {
  unit: Unit;
  /** Position in the answer, to keep the model's order where the page gives none. */
  index: number;
  /** The title it is saved under: the model's, or its heading's own when the model's adds words to it. */
  title: string;
  page: SeenPage;
  /** Index into the page's outline headings, for a heading unit; null for a linked unit. */
  heading: number | null;
  minutes: number | null;
  measured: boolean;
}

export function checkUnits(input: {
  material: Pick<Material, "url" | "kind" | "minutes" | "minutesBasis" | "practice">;
  role: StructureRole;
  answer: StructureAnswer;
  pages: SeenPage[];
  /** Lists the `items` tool returned in this run. */
  lists: PracticeList[];
}): UnitsVerdict {
  const { material, role, answer, pages, lists } = input;
  const kinds = ROLE_KINDS[role];
  const practiceRole = kinds.includes("practice");
  // Rule 1: whole or empty means no reading units and no size change; a list from the `items` tool still counts.
  if (answer.whole || answer.units.length === 0) {
    const facts = ["whole"];
    const list = practiceList(answer.listUrl, lists, practiceRole, [], material.url, pages, facts);
    return { toc: null, minutes: null, basis: null, list, refused: null, facts };
  }

  const facts: string[] = [];
  const refuse = (reason: string): UnitsVerdict => ({ toc: null, minutes: null, basis: null, list: null, refused: reason, facts });
  const book = material.kind === "book";
  const source = pageAt(pages, material.url);

  // Rule 2: units by role. A relative `at` is read against the source's address.
  const units = answer.units.filter((u) => kinds.includes(u.kind)).map((u) => ({ ...u, at: absoluteAt(u.at, material.url) }));
  const discarded = answer.units.length - units.length;
  if (discarded > 0) facts.push(`${discarded} ${role === "read" ? "practice" : "reading"} units discarded: the source is ${role} only`);

  // Rules 3 and 4: units point to fetched pages, and their titles are on them.
  const placed: Placed[] = [];
  const unfetched: Record<UnitKind, number> = { read: 0, practice: 0 };
  const untitled: Record<UnitKind, number> = { read: 0, practice: 0 };
  units.forEach((unit, index) => {
    const target = locate(unit, pages, source, book);
    const title = target ? seenTitle(unit.title, target.page, target.heading, pages, book) : null;
    if (target && title) {
      placed.push({ unit, index, title, ...target, ...sizeOf(unit, target.page, target.heading) });
      return;
    }
    if (target) untitled[unit.kind]++;
    else unfetched[unit.kind]++;
  });
  const allUnfetched = unfetched.read + unfetched.practice;
  const allUntitled = untitled.read + untitled.practice;
  if (allUnfetched > 0) facts.push(`${allUnfetched} of ${units.length} units point to no fetched page or heading`);
  if (allUntitled > 0) facts.push(`${allUntitled} of ${units.length} titles not on the page`);

  // Rule 5: too many unseen, per kind. Unseen reading units refuse the verdict; unseen practice units only keep the
  // practice units from becoming an item list.
  const readCount = units.filter((u) => u.kind === "read").length;
  if (unfetched.read + untitled.read > MAX_UNSEEN_SHARE * readCount) return refuse(`units refused: ${unseenWhy(readCount, unfetched.read, untitled.read)}`);
  const practiceCount = units.length - readCount;
  const practiceSeen = unfetched.practice + untitled.practice <= MAX_UNSEEN_SHARE * practiceCount;
  if (!practiceSeen) facts.push(`practice units refused: ${unseenWhy(practiceCount, unfetched.practice, untitled.practice)}`);

  // Rule 6: nested and repeated units.
  const kept = withoutRepeats(placed, pages, book);
  if (kept.length < placed.length) facts.push(`${placed.length - kept.length} repeated units dropped`);

  const home = book ? contentsPage(kept, source) : source;
  const reading = inPageOrder(kept.filter((p) => p.unit.kind === "read"), home);
  const practice = inPageOrder(kept.filter((p) => p.unit.kind === "practice"), home);

  // Rule 8: coverage, for reading heading units on each page. Books skip it.
  if (!book) {
    for (const page of new Set(reading.filter((p) => p.heading !== null).map((p) => p.page))) {
      const total = page.outline?.words ?? 0;
      if (total <= 0) continue;
      const covered = reading.filter((p) => p.page === page && p.heading !== null).reduce((sum, p) => sum + page.outline!.headings[p.heading!].words, 0);
      if (covered < MIN_UNIT_COVERAGE * total) return refuse(`units refused: cover ${Math.floor((100 * covered) / total)}% of the page`);
    }
  }

  // Rule 9: count. A role with reading but an answer with none leaves the toc empty without refusing.
  if (reading.length > 0 && reading.length < MIN_CHAPTERS) return refuse(`units refused: ${reading.length} reading units, fewer than ${MIN_CHAPTERS}`);
  if (reading.length > MAX_CHAPTERS) return refuse(`units refused: ${reading.length} reading units, more than ${MAX_CHAPTERS}`);

  // Rules 10 and 11: the toc.
  let toc: ChapterList | null = null;
  if (reading.length > 0) {
    const tocUrl = book && home && home !== source ? home.url : material.url;
    const draft: ChapterList = {
      source: "page",
      url: tocUrl,
      printPages: false,
      end: null,
      chapters: reading.map((p): Chapter => ({
        n: null,
        title: clip(p.title, MAX_HEADING)!,
        page: null,
        minutes: book ? null : p.minutes,
        sections: p.heading !== null ? sectionsOf(p.page.outline!.headings, p.heading) : [],
        url: unitUrl(p.unit.at, tocUrl),
        group: clip(p.unit.group, MAX_HEADING),
      })),
    };
    // A book's chapters share out its size only when that size was measured: an estimate is no size to share.
    const bookMinutes = material.minutesBasis === "measured" ? (material.minutes ?? null) : null;
    const parsed = chapterListSchema.safeParse(book ? withChapterSizes(draft, bookMinutes) : draft);
    if (!parsed.success) return refuse("units refused: the units do not make a chapter list");
    toc = parsed.data;
  }

  // Rule 12: the new size. A book keeps its catalogue size.
  let minutes: number | null = null;
  let basis: MinutesBasis | null = null;
  if (!book && reading.length > 0) {
    if (reading.every((p) => p.minutes !== null)) {
      minutes = Math.min(MAX_MINUTES, reading.reduce((sum, p) => sum + p.minutes!, 0));
      basis = reading.every((p) => p.measured) ? "measured" : "estimated";
    } else {
      facts.push(`size kept: ${reading.filter((p) => p.minutes === null).length} units have no minutes`);
    }
  }

  // Rule 13: practice. It never refuses the reading toc; it only makes no list.
  const list = practiceList(answer.listUrl, lists, practiceRole, material.practice && practiceSeen ? practice : [], material.url, pages, facts);
  return { toc, minutes, basis, list, refused: null, facts };
}

/** Why units went unseen: "3 of 22 titles not on the page", "6 of 7 point to no fetched page or heading", or both. */
function unseenWhy(count: number, unfetched: number, untitled: number): string {
  const nowhere = "point to no fetched page or heading";
  const offPage = "titles not on the page";
  if (untitled === 0) return `${unfetched} of ${count} ${nowhere}`;
  if (unfetched === 0) return `${untitled} of ${count} ${offPage}`;
  return `${unfetched + untitled} of ${count} unseen: ${unfetched} ${nowhere}, ${untitled} ${offPage}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Where a unit points

/**
 * The pages the answer's units (of the role's kinds) point at that no tool fetched but a fetched page links to: the
 * finder measures these before the check, so a unit is not refused only because the model skipped `measure`. Each
 * page once, without its fragment, in the answer's order. A page no fetched page links to is left alone.
 */
export function citedUnfetched(answer: StructureAnswer, role: StructureRole, base: string, pages: SeenPage[]): string[] {
  if (answer.whole) return [];
  const linked = new Set(pages.flatMap((p) => p.outline?.links.map((l) => canonicalUrl(l.url)) ?? []).filter((k): k is string => k !== null));
  const kinds = ROLE_KINDS[role];
  const cited = new Map<string, string>();
  for (const unit of answer.units) {
    if (!kinds.includes(unit.kind)) continue;
    const at = absoluteAt(unit.at, base);
    const url = at.split("#")[0];
    const key = canonicalUrl(url);
    if (!key || cited.has(key) || !linked.has(key) || pageAt(pages, url)) continue;
    cited.set(key, url);
  }
  return [...cited.values()];
}

/** The seen page at this address, by its requested or final URL. */
function pageAt(pages: SeenPage[], url: string): SeenPage | null {
  const key = canonicalUrl(url);
  if (!key) return null;
  return pages.find((p) => canonicalUrl(p.url) === key || canonicalUrl(p.finalUrl) === key) ?? null;
}

/** A fragment as headings carry it: percent-decoded, lower-cased, no `user-content-`. */
function anchorKey(raw: string): string {
  let value = raw;
  try {
    value = decodeURIComponent(value);
  } catch {
    // Not valid percent-encoding: compare it as written.
  }
  return value.toLowerCase().replace(/^user-content-/, "");
}

/**
 * The page a unit's `at` points to, and its heading: the one its fragment names, or, on the source page, the one
 * that carries its title. Null when no tool returned the page, or the fragment names no heading on it, or (not for a
 * book) it points at the source page with headings but names none of them: that unit is the whole page again, beside
 * its sections.
 */
function locate(unit: Unit, pages: SeenPage[], source: SeenPage | null, book: boolean): { page: SeenPage; heading: number | null } | null {
  const hash = unit.at.indexOf("#");
  const fragment = hash === -1 ? "" : anchorKey(unit.at.slice(hash + 1));
  const page = pageAt(pages, hash === -1 ? unit.at : unit.at.slice(0, hash));
  if (!page) return null;
  const headings = page.outline?.headings ?? [];
  if (fragment) {
    const heading = headings.findIndex((h) => h.anchor !== null && anchorKey(h.anchor) === fragment);
    return heading === -1 ? null : { page, heading };
  }
  const title = normalText(unit.title);
  const heading = page === source && title ? headings.findIndex((h) => normalText(h.title) === title) : -1;
  if (heading === -1 && page === source && !book && headings.length > 0) return null;
  return { page, heading: heading === -1 ? null : heading };
}

/** `at` as an absolute address: a fragment or path the model wrote is read against the source's URL. */
function absoluteAt(at: string, base: string): string {
  const trimmed = at.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return trimmed;
  }
}

/** True when `needle` sits in `hay` as whole words. */
function within(needle: string, hay: string): boolean {
  return needle !== "" && ` ${hay} `.includes(` ${needle} `);
}

/** True when the normalised title sits inside what the page says. */
function inside(title: string, said: string | null | undefined): boolean {
  return within(title, normalText(said ?? ""));
}

/**
 * Rule 4: the title the unit is saved under, or null when it is not on the page. Every word saved must be the page's:
 * - a heading unit's title sits inside its heading (kept as the model wrote it), or its heading sits inside the
 *   title (saved as the heading's own title, so no word the page lacks survives);
 * - a linked unit's title sits inside the text of a link to its page on any seen page, or in the rest of the table row
 *   or list item that link sits in (a question beside its "Solution" link), or the page's own title or first heading;
 * - a book's title sits among its page's headings, link text and text.
 */
function seenTitle(rawTitle: string, page: SeenPage, heading: number | null, pages: SeenPage[], book: boolean): string | null {
  const title = normalText(rawTitle);
  if (!title) return null;
  const outline = page.outline;
  if (book) {
    const hay = [...(outline?.headings.map((h) => h.title) ?? []), ...(outline?.links.map((l) => l.text) ?? []), page.text].join("\n");
    return inside(title, hay) ? rawTitle : null;
  }
  if (heading !== null) {
    const own = outline!.headings[heading].title;
    if (inside(title, own)) return rawTitle;
    return within(normalText(own), title) ? own : null;
  }
  const keys = pageKeys(page);
  const linked = pages.some((p) => p.outline?.links.some((l) => keys.has(canonicalUrl(l.url) ?? "") && (inside(title, l.text) || inside(title, l.context))));
  return linked || inside(title, page.title) || inside(title, outline?.headings[0]?.title) ? rawTitle : null;
}

function pageKeys(page: SeenPage): Set<string> {
  return new Set([canonicalUrl(page.url), canonicalUrl(page.finalUrl)].filter((k): k is string => k !== null));
}

// ---------------------------------------------------------------------------------------------------------------
// Sizes

function boundedMinutes(n: number): number {
  return Math.min(MAX_MINUTES, Math.max(1, Math.round(n)));
}

/**
 * Rule 7. A heading unit is its words at reading speed; a linked unit is its page's runtime, or its words when the
 * page is long enough to be the work. Anything else (a short page, a PDF, a page with nothing measured) keeps the
 * model's minutes, marked estimated. A PDF is unmeasured: code can't tell slides from pages.
 */
function sizeOf(unit: Unit, page: SeenPage, heading: number | null): { minutes: number | null; measured: boolean } {
  if (heading !== null) return { minutes: boundedMinutes(page.outline!.headings[heading].words / WORDS_PER_MINUTE), measured: true };
  if (page.durationMinutes !== null && page.durationMinutes > 0) return { minutes: boundedMinutes(page.durationMinutes), measured: true };
  if (page.pdfPages === null && (page.words ?? 0) >= MIN_MEASURED_WORDS) return { minutes: boundedMinutes(page.words! / WORDS_PER_MINUTE), measured: true };
  const claimed = unit.minutes;
  return { minutes: claimed !== null && Number.isFinite(claimed) && claimed > 0 ? boundedMinutes(claimed) : null, measured: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Shape

/** Where a heading's section ends: the next heading of the same or a higher level. */
function spanEnd(headings: OutlineHeading[], i: number): number {
  let end = i + 1;
  while (end < headings.length && headings[end].level > headings[i].level) end++;
  return end;
}

/**
 * Rule 6. A second unit at the same place (the same heading, or the same linked page) is dropped, and so is a heading
 * unit inside another kept heading unit's section, each within its kind. The answer's order is kept. A book's chapters
 * may all point at its contents page, so there a unit with no heading is told apart by its title too.
 */
function withoutRepeats(placed: Placed[], pages: SeenPage[], book: boolean): Placed[] {
  const dropped = new Set<Placed>();
  const places = new Set<string>();
  for (const p of placed) {
    const place = p.heading !== null ? `#${p.heading}` : book ? ` ${normalText(p.title)}` : "";
    const key = `${p.unit.kind} ${pages.indexOf(p.page)}${place}`;
    if (places.has(key)) dropped.add(p);
    else places.add(key);
  }
  for (const p of placed) {
    if (dropped.has(p) || p.heading === null) continue;
    const headings = p.page.outline!.headings;
    const inside = placed.some(
      (q) =>
        q !== p &&
        !dropped.has(q) &&
        q.unit.kind === p.unit.kind &&
        q.page === p.page &&
        q.heading !== null &&
        q.heading < p.heading! &&
        headings[q.heading].level < headings[p.heading!].level &&
        p.heading! < spanEnd(headings, q.heading),
    );
    if (inside) dropped.add(p);
  }
  return placed.filter((p) => !dropped.has(p));
}

/**
 * A book's contents page: its own page when a tool returned it, unless another page holds more than one of its
 * chapters and more than its own page does (chapters each on a page of their own leave the book's page in place).
 * Without its own page, the page most chapters point to (the first of a tie).
 */
function contentsPage(kept: Placed[], source: SeenPage | null): SeenPage | null {
  const counts = new Map<SeenPage, number>();
  for (const p of kept) if (p.unit.kind === "read") counts.set(p.page, (counts.get(p.page) ?? 0) + 1);
  let best: SeenPage | null = null;
  for (const [page, n] of counts) if (best === null || n > counts.get(best)!) best = page;
  if (!source) return best;
  return best && best !== source && counts.get(best)! > 1 && counts.get(best)! > (counts.get(source) ?? 0) ? best : source;
}

/**
 * Rule 9. Units in the order of the home page: a heading unit by its heading; a unit elsewhere by the first link to its
 * page, after the heading that link sits under. Units the home page gives no place come last, in the answer's order.
 */
function inPageOrder(units: Placed[], home: SeenPage | null): Placed[] {
  const outline = home?.outline;
  const position = (p: Placed): number[] => {
    if (!outline) return [Infinity];
    if (p.page === home && p.heading !== null) return [p.heading, 0, 0, 0];
    const keys = pageKeys(p.page);
    const link = outline.links.findIndex((l) => keys.has(canonicalUrl(l.url) ?? ""));
    if (link === -1) return [Infinity];
    return [headingUnder(outline.headings, keys), 1, link, p.heading ?? -1];
  };
  const keyed = units.map((p) => ({ p, key: [...position(p), p.index] }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  return keyed.map((k) => k.p);
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -Infinity;
    const y = b[i] ?? -Infinity;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The deepest heading the first link to a page sits under: the first section that links it, then its first sub-section that does, and so on. -1 before any heading. */
function headingUnder(headings: OutlineHeading[], keys: Set<string>): number {
  const holds = (h: OutlineHeading) => h.links.some((l) => keys.has(canonicalUrl(l.url) ?? ""));
  let at = headings.findIndex(holds);
  if (at === -1) return -1;
  for (;;) {
    const end = spanEnd(headings, at);
    let next = -1;
    for (let j = at + 1; j < end; j++) {
      if (holds(headings[j])) {
        next = j;
        break;
      }
    }
    if (next === -1) return at;
    at = next;
  }
}

/** A heading's direct sub-headings, as today's chapter lists carry them. */
function sectionsOf(headings: OutlineHeading[], i: number): string[] {
  const out: string[] = [];
  const end = spanEnd(headings, i);
  for (let j = i + 1; j < end; j++) {
    let direct = true;
    for (let k = i + 1; k < j; k++) if (headings[k].level < headings[j].level) direct = false;
    if (!direct) continue;
    const title = clip(headings[j].title, MAX_HEADING);
    if (title && !SECTION_SKIP_RE.test(title)) out.push(title);
  }
  return out.slice(0, MAX_SECTIONS);
}

/** The unit's `at` when it is somewhere other than `base` (a fragment always is), else null. */
function unitUrl(at: string, base: string): string | null {
  if (at.includes("#")) return at.trim();
  return canonicalUrl(at) === canonicalUrl(base) ? null : at.trim();
}

// ---------------------------------------------------------------------------------------------------------------
// Practice

/** What the seen pages hold, for the item check: their addresses, titles, text, headings and links. */
function seenText(pages: SeenPage[]): string {
  return pages
    .flatMap((p) => [p.url, p.finalUrl, p.title ?? "", p.text, ...(p.outline?.headings.map((h) => h.title) ?? []), ...(p.outline?.links.flatMap((l) => [l.url, l.text]) ?? [])])
    .join("\n");
}

/** A practice section holding at least this many rows of a problem table or list is its problems, not one item. */
const MIN_SECTION_ROWS = 3;

const ROW_DIFFICULTY = /\b(easy|medium|hard)\b/i;

/**
 * The rows of a table or list under a heading, each its links in order: the item's own link first, then its solutions.
 * Only links whose row says something beside them (a number, a difficulty) count. A row ends where that text changes,
 * or where a link goes to the same site as the row's first link: the next problem.
 */
function sectionRows(heading: OutlineHeading): OutlineLink[][] {
  const rows: OutlineLink[][] = [];
  for (const link of heading.links) {
    if (!link.context) continue;
    const row = rows.at(-1);
    if (row && row[0].context === link.context && hostKey(row[0].url) !== hostKey(link.url)) row.push(link);
    else rows.push([link]);
  }
  return rows;
}

function hostKey(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A practice unit as items: the problems in its section's rows when it has enough of them, otherwise itself. */
function unitItems(p: Placed, sourceUrl: string): ItemDraft[] {
  const rows = p.heading === null ? [] : sectionRows(p.page.outline!.headings[p.heading]);
  if (rows.length >= MIN_SECTION_ROWS) {
    return rows.map(([item, solution]) => ({
      title: item.text,
      number: itemNumber(item.context),
      group: p.title,
      difficulty: item.context!.match(ROW_DIFFICULTY)?.[1].toLowerCase() ?? null,
      url: item.url,
      solutionUrl: solution?.url ?? null,
      minutes: null,
    }));
  }
  // Doing takes longer than reading the words that set it, so only a measured runtime (a video lab) sizes an item.
  const minutes = p.heading === null && p.page.durationMinutes && p.minutes !== null && p.minutes <= MAX_ITEM_MINUTES ? p.minutes : null;
  return [{ title: p.title, number: null, group: p.unit.group, difficulty: null, url: unitUrl(p.unit.at, sourceUrl), solutionUrl: null, minutes }];
}

/**
 * Rule 13, for a role with practice only. The `items` tool's list when `listUrl` names one; otherwise the practice
 * units given (none when the material has no practice or too many were unseen) as items, a section of a problem table
 * as the problems in its rows. Either way it goes through `validateItemList` against what the tools returned.
 */
function practiceList(
  listUrl: string | null,
  lists: PracticeList[],
  practiceRole: boolean,
  practice: Placed[],
  sourceUrl: string,
  pages: SeenPage[],
  facts: string[],
): PracticeList | null {
  if (!practiceRole) return null;
  const key = listUrl ? canonicalUrl(listUrl) : null;
  const named = key ? lists.find((l) => canonicalUrl(l.url) === key) : undefined;
  if (named) {
    const list = validateItemList({ url: named.url, source: named.source, items: named.items }, seenText(pages));
    facts.push(list ? `practice list from ${named.url}: ${list.items.length} items` : "practice list refused by the item check");
    return list;
  }
  if (practice.length === 0) return null;
  const perUnit = practice.map((p) => unitItems(p, sourceUrl));
  const items = perUnit.flat();
  const sections = perUnit.filter((drafts) => drafts.length > 1).length;
  const list = validateItemList({ url: sourceUrl, source: "page", items }, seenText(pages));
  const from = sections > 0 ? `, from the rows of ${sections} section${sections === 1 ? "" : "s"}` : "";
  facts.push(list ? `practice units: ${list.items.length} items${from}` : "practice units refused by the item check");
  return list;
}
