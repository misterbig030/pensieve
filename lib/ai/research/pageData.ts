import { KEY_FIELD, pageDataSets, type DataFile, type RecordSet } from "./dataFile";

/**
 * The data a page carries for its own scripts: JSON script blocks (`application/json`, such as Next.js's
 * `__NEXT_DATA__`, and `application/ld+json`) and the rows of a React Server Components payload
 * (`self.__next_f.push([1,"…"])`). A course or catalogue page built by a script often shows only its section titles
 * as text and keeps every lesson, with its kind and length, in this data. Nothing here knows any site.
 */

const JSON_SCRIPT = /<script\b[^>]*\btype\s*=\s*["']?application\/(?:ld\+)?json["']?[^>]*>([\s\S]*?)<\/script>/gi;
const RSC_PUSH = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
/** One row of an RSC payload: its id, a colon, its value. */
const RSC_ROW = /^([0-9a-f]+):([[{][\s\S]*)$/;

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Each JSON value the page's scripts are given, with a name for where it came from. */
export function pageDataRoots(html: string): { name: string; value: unknown }[] {
  const roots: { name: string; value: unknown }[] = [];
  let script = 0;
  for (const m of html.matchAll(JSON_SCRIPT)) {
    script += 1;
    const value = parsed(m[1].trim());
    if (value !== undefined) roots.push({ name: `script${script}`, value });
  }
  const payload = [...html.matchAll(RSC_PUSH)]
    .map((m) => parsed(m[1]))
    .filter((s): s is string => typeof s === "string")
    .join("");
  // Rows are separated by line breaks; a text row may hold line breaks of its own, but it is not JSON and is skipped.
  for (const line of payload.split(/\n(?=[0-9a-f]+:)/)) {
    const row = line.match(RSC_ROW);
    if (!row) continue;
    const value = parsed(row[2]);
    if (value !== undefined) roots.push({ name: `row${row[1]}`, value });
  }
  return roots;
}

/**
 * The page's embedded data as a data file, its record sets found at any depth, and its JSON as text (what a title
 * mapped from it must appear in); null when it carries no list of records.
 */
export function pageDataFile(html: string): { file: DataFile; text: string } | null {
  const roots = pageDataRoots(html);
  const sets = pageDataSets(roots);
  if (sets.length === 0) return null;
  return { file: { kind: "json", sets }, text: roots.map((r) => JSON.stringify(r.value)).join("\n") };
}

/** One list in a page's embedded data, as the structure finder is told of it: how many records, and their fields. */
export interface PageList {
  records: number;
  fields: string[];
}

/** A list shorter than this is not worth an `items` call. */
export const PAGE_LIST_MIN_RECORDS = 5;
/** At most this many lists are kept, the largest first. */
const MAX_PAGE_LISTS = 4;

/**
 * The page's lists of at least `PAGE_LIST_MIN_RECORDS` records in its embedded data, largest first, at most
 * `MAX_PAGE_LISTS`; the same list met twice (a render tree often repeats its data) is kept once.
 */
export function pageLists(html: string): PageList[] {
  const seen = new Set<string>();
  const lists: PageList[] = [];
  const sets = pageDataSets(pageDataRoots(html)).filter((s) => s.records.length >= PAGE_LIST_MIN_RECORDS);
  for (const set of sets.sort((a: RecordSet, b: RecordSet) => b.records.length - a.records.length)) {
    const fields = set.keys.filter((k) => k !== KEY_FIELD);
    const key = `${set.records.length}:${fields.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lists.push({ records: set.records.length, fields });
    if (lists.length === MAX_PAGE_LISTS) break;
  }
  return lists;
}
