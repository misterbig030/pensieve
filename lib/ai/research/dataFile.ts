import { z } from "zod";
import type { ItemDraft } from "./itemFinder";

/**
 * A machine-readable list read whole (JSON or CSV), its record sets, a small sample of them for the model, and the
 * model's field mapping applied to every record by code. Nothing here knows any site: the file's own shape and the
 * mapping the model wrote decide everything.
 */

/** One record of a data file, with the object it sits in when the records were gathered from nested arrays. */
export interface DataRecord {
  value: Record<string, unknown>;
  parent: Record<string, unknown> | null;
}

/** A run of records in the file: the top-level array, an array under a key, or arrays nested in an array (`a[].b`). */
export interface RecordSet {
  /** "" for the top level; dot-separated keys, with `[]` after a key whose array is walked into. */
  path: string;
  records: DataRecord[];
  /** Keys of the records, in first-seen order. */
  keys: string[];
  /** Keys of the parent objects, for nested sets. */
  parentKeys: string[];
}

export interface DataFile {
  kind: "json" | "csv";
  sets: RecordSet[];
  /** True when the data was too large to walk whole, so a set past the part walked is missing. */
  cut?: boolean;
}

/** Record sets shorter than this are not lists of items. */
const MIN_RECORDS = 3;
const MAX_DEPTH = 3;
/** Records shown to the model from the largest set, and from each other set. */
export const SAMPLE_RECORDS = 20;
const OTHER_SAMPLE_RECORDS = 3;
const MAX_SETS = 4;
/** Sets past the sampled ones are still named, with their size and fields, up to this many: a page's data holds many. */
const MAX_NAMED_SETS = 24;
const NAMED_SET_FIELDS = 12;
const SAMPLE_RECORD_CHARS = 400;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function keysOf(objects: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const o of objects.slice(0, 50)) for (const k of Object.keys(o)) keys.add(k);
  return [...keys];
}

function objectsIn(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const objects = value.filter(isPlainObject);
  return objects.length * 2 >= value.length ? objects : null;
}

/** The field a record taken from an object keyed by name keeps its key in. */
export const KEY_FIELD = "_key";

/** An object that reads as one record: most of its values are not objects themselves. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  isPlainObject(v) && Object.values(v).filter(isPlainObject).length * 2 < Object.keys(v).length;

/** The records of an object keyed by name (`{"Two Sum": {...}, ...}`), each with its key in `_key`; null when most values are not records. */
function entriesIn(value: unknown): Record<string, unknown>[] | null {
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  const records = entries.filter(([, v]) => isRecord(v));
  return records.length > 0 && records.length * 2 >= entries.length ? records.map(([key, v]) => ({ [KEY_FIELD]: key, ...(v as Record<string, unknown>) })) : null;
}

function jsonSets(root: unknown): RecordSet[] {
  const sets: RecordSet[] = [];
  const add = (path: string, records: DataRecord[]): boolean => {
    if (records.length < MIN_RECORDS) return false;
    sets.push({ path, records, keys: keysOf(records.map((r) => r.value)), parentKeys: keysOf(records.map((r) => r.parent).filter(isPlainObject)) });
    return true;
  };
  /** These objects as a set, and the arrays nested one level in them (groups holding their items), gathered across all of them. */
  const addObjects = (path: string, objects: Record<string, unknown>[]): boolean => {
    let added = add(path, objects.map((o) => ({ value: o, parent: null })));
    for (const key of keysOf(objects)) {
      const nested: DataRecord[] = [];
      for (const parent of objects) for (const child of objectsIn(parent[key]) ?? []) nested.push({ value: child, parent });
      added = add(`${path}[].${key}`, nested) || added;
    }
    return added;
  };
  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    const objects = objectsIn(value);
    if (objects) {
      addObjects(path, objects);
      return;
    }
    if (!isPlainObject(value)) return;
    // Records keyed by name, `*` standing for every key.
    const keyedPath = path ? `${path}.*` : "*";
    const keyed = entriesIn(value);
    const keyedAdded = keyed !== null && keyed.length >= MIN_RECORDS && addObjects(keyedPath, keyed);
    // Groups keyed by name, each holding records keyed by name: every group's records, the group's key as their parent's.
    const grouped: DataRecord[] = [];
    if (!keyedAdded) for (const [key, group] of Object.entries(value)) for (const child of entriesIn(group) ?? []) grouped.push({ value: child, parent: { [KEY_FIELD]: key } });
    const groupedAdded = add(`${keyedPath}.*`, grouped);
    for (const [key, child] of Object.entries(value)) {
      // What a set above already holds is not walked again.
      if ((keyedAdded && isRecord(child)) || (groupedAdded && entriesIn(child))) continue;
      walk(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  walk(root, "", 0);
  return sets;
}

/** Nodes walked in one page's embedded data: a render tree is large, and its lists sit deep in it. */
const MAX_PAGE_DATA_NODES = 200_000;
/** How many levels of lists nested in records are gathered across their parents (a course's modules, their lessons). */
const MAX_GATHERED_LEVELS = 2;
const SAME_SET_CHARS = 300;

/**
 * Every run of records anywhere in the data a page carries for its scripts, at any depth, each under the full path to
 * it from its root's name: a list of records, or records keyed by name (`.*`, each record's key in `_key`). A page's
 * data nests its lists deep inside a render tree that `jsonSets` would not walk into. A record's parent is the object
 * the list sits in. Lists nested in a run of records are also gathered across all of them (`a[].b`, as `jsonSets`
 * does): a course's lessons kept in each of its modules are one list, each lesson's parent its module. A run met again
 * (a render tree often carries its data twice) is kept once, at its first path. One budget of `MAX_PAGE_DATA_NODES`
 * covers all of a page's roots; `cut` says it ran out.
 */
export function pageDataSets(roots: { name: string; value: unknown }[]): { sets: RecordSet[]; cut: boolean } {
  const sets: RecordSet[] = [];
  const seen = new Set<string>();
  let nodes = 0;
  let cut = false;
  /** What two copies of one run share: its size and its first and last records. */
  const sameAs = (values: Record<string, unknown>[]) =>
    `${values.length}:${JSON.stringify(values[0]).slice(0, SAME_SET_CHARS)}:${JSON.stringify(values[values.length - 1]).slice(0, SAME_SET_CHARS)}`;
  const add = (path: string, records: DataRecord[]) => {
    if (records.length < MIN_RECORDS) return;
    const key = sameAs(records.map((r) => r.value));
    if (seen.has(key)) return;
    seen.add(key);
    sets.push({ path, records, keys: keysOf(records.map((r) => r.value)), parentKeys: keysOf(records.map((r) => r.parent).filter(isPlainObject)) });
  };
  /**
   * The lists nested in these records under each key, gathered across them when at least two hold a different one: a
   * list two parents both carry is one list, not two.
   */
  const gather = (path: string, objects: Record<string, unknown>[], level: number) => {
    if (level > MAX_GATHERED_LEVELS || objects.length < 2) return;
    for (const key of keysOf(objects)) {
      const listed: DataRecord[] = [];
      const keyed: DataRecord[] = [];
      const met = new Set<string>();
      let inLists = 0;
      let inKeyed = 0;
      for (const parent of objects) {
        const list = objectsIn(parent[key]);
        const named = list ? null : entriesIn(parent[key]);
        const values = list ?? named;
        if (!values || met.has(sameAs(values))) continue;
        met.add(sameAs(values));
        if (list) {
          inLists += 1;
          for (const value of list) listed.push({ value, parent });
        } else if (named) {
          inKeyed += 1;
          for (const value of named) keyed.push({ value, parent });
        }
      }
      nodes += listed.length + keyed.length;
      if (inLists >= 2) {
        add(`${path}[].${key}`, listed);
        gather(`${path}[].${key}`, listed.map((r) => r.value), level + 1);
      }
      if (inKeyed >= 2) {
        add(`${path}[].${key}.*`, keyed);
        gather(`${path}[].${key}.*`, keyed.map((r) => r.value), level + 1);
      }
    }
  };
  const walk = (value: unknown, path: string, owner: Record<string, unknown> | null) => {
    if (++nodes > MAX_PAGE_DATA_NODES) {
      cut = true;
      return;
    }
    if (Array.isArray(value)) {
      const objects = objectsIn(value);
      if (objects) {
        add(path, objects.map((o) => ({ value: o, parent: owner })));
        gather(path, objects, 1);
      }
      value.forEach((child, i) => walk(child, `${path}[${i}]`, owner));
      return;
    }
    if (!isPlainObject(value)) return;
    const keyed = entriesIn(value);
    if (keyed) {
      add(`${path}.*`, keyed.map((o) => ({ value: o, parent: owner })));
      gather(`${path}.*`, keyed, 1);
    }
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`, value);
  };
  for (const root of roots) walk(root.value, root.name, null);
  return { sets, cut };
}

/** Splits CSV (or TSV) text into rows, honouring quoted fields with delimiters, doubled quotes and line breaks. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function csvSet(text: string, truncated: boolean): RecordSet | null {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? "\t" : ",";
  const rows = parseDelimited(text, delimiter);
  // A file cut at the size limit may end in half a row.
  if (truncated) rows.pop();
  const [header, ...body] = rows;
  if (!header || header.length < 2) return null;
  const names = header.map((h, i) => h.trim() || `column ${i + 1}`);
  const fitting = body.filter((r) => r.length === names.length);
  if (fitting.length < MIN_RECORDS || fitting.length * 10 < body.length * 9) return null;
  const records = fitting.map((r) => ({ value: Object.fromEntries(names.map((n, i) => [n, r[i].trim()])), parent: null }));
  return { path: "", records, keys: names, parentKeys: [] };
}

/** The file's record sets when the text is JSON with a list of records in it, or CSV/TSV with a header row; else null. */
export function parseDataFile(text: string, truncated = false): DataFile | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let root: unknown;
    try {
      root = JSON.parse(trimmed);
    } catch {
      return null;
    }
    const sets = jsonSets(root);
    return sets.length > 0 ? { kind: "json", sets } : null;
  }
  const set = csvSet(text, truncated);
  return set ? { kind: "csv", sets: [set] } : null;
}

/** A field with this few distinct short values over all records reads as a kind or a flag, and its values are listed. */
const MAX_LISTED_VALUES = 12;
const MAX_LISTED_VALUE_CHARS = 40;

/**
 * Each field of the set that reads as a kind or a flag, with every value it takes over all records and how often: the
 * part of a file a source names (its notebooks, its "150") may not show in the first records.
 */
function valueCounts(set: RecordSet): string[] {
  const lines: string[] = [];
  for (const key of set.keys) {
    if (key === KEY_FIELD) continue;
    const counts = new Map<string, number>();
    let kind = true;
    for (const r of set.records) {
      const v = r.value[key];
      if (typeof v !== "string" && typeof v !== "boolean") continue;
      const s = String(v);
      counts.set(s, (counts.get(s) ?? 0) + 1);
      if (s.length > MAX_LISTED_VALUE_CHARS || counts.size > MAX_LISTED_VALUES) {
        kind = false;
        break;
      }
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (!kind || counts.size < 2 || total < set.records.length / 2 || counts.size === total) continue;
    lines.push(`Values of ${key} over all ${set.records.length} records: ${[...counts].map(([v, n]) => `${JSON.stringify(v)} (${n})`).join(", ")}`);
  }
  return lines;
}

/**
 * What the model sees of a data file: for the largest record sets, each one's path, size and keys, the values of its
 * kind fields, and its first records; every other set by its path, size and keys, so a smaller set (a course's lessons
 * beside its menus and reviews) can still be mapped.
 */
export function sampleDataFile(file: DataFile): string {
  const ranked = [...file.sets].sort((a, b) => b.records.length - a.records.length);
  const sets = ranked.slice(0, MAX_SETS);
  const rest = ranked.slice(MAX_SETS, MAX_NAMED_SETS);
  const lines: string[] = [];
  sets.forEach((set, i) => {
    if (file.kind === "json") lines.push(`Records at path "${set.path}"${set.path === "" ? " (the top level)" : ""}: ${set.records.length}`);
    else lines.push(`CSV rows: ${set.records.length}`);
    if (set.path.includes("*")) lines.push(`(* stands for every key of an object; each record's key is in the field ${KEY_FIELD})`);
    lines.push(`Fields: ${set.keys.join(", ")}`);
    if (set.parentKeys.length > 0) lines.push(`Fields of the object each record sits in (write them as ../field): ${set.parentKeys.join(", ")}`);
    for (const line of valueCounts(set)) lines.push(line);
    const n = i === 0 ? SAMPLE_RECORDS : OTHER_SAMPLE_RECORDS;
    lines.push(`First ${Math.min(n, set.records.length)} records:`);
    for (const r of set.records.slice(0, n)) {
      const own = JSON.stringify(r.value);
      lines.push(own.length > SAMPLE_RECORD_CHARS ? `${own.slice(0, SAMPLE_RECORD_CHARS)}…` : own);
    }
    lines.push("");
  });
  if (rest.length > 0) {
    lines.push(`Other record sets, not sampled (path: records; fields):`);
    for (const set of rest) {
      const keys = set.keys.filter((k) => k !== KEY_FIELD);
      lines.push(`"${set.path}": ${set.records.length}; ${keys.slice(0, NAMED_SET_FIELDS).join(", ")}${keys.length > NAMED_SET_FIELDS ? ", …" : ""}`);
    }
    const unnamed = file.sets.length - MAX_NAMED_SETS;
    if (unnamed > 0) lines.push(`(and ${unnamed} smaller sets)`);
  }
  if (file.cut) lines.push("(This data was too large to read whole: a list past the part read is not shown.)");
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------------------------------------------
// The mapping

export const MINUTES_UNITS = ["minutes", "seconds", "hours"] as const;
const PER_UNIT: Record<(typeof MINUTES_UNITS)[number], number> = { minutes: 1, seconds: 1 / 60, hours: 60 };

export const fieldMappingSchema = z.object({
  found: z.boolean().describe("True only when this file lists the source's items"),
  path: z.string().nullable().describe('JSON: the path of the records that are the items, exactly as listed; null for CSV'),
  title: z.string().describe("The field holding each item's title"),
  number: z.string().nullable().describe("The field holding the item's own number or label on its site, or one that starts with it (a code like 0049-group-anagrams); null when none"),
  group: z.string().nullable().describe("The field holding the item's topic or group; ../field for the object it sits in; null when none"),
  difficulty: z.string().nullable().describe("The field holding easy/medium/hard; null when none"),
  minutes: z.string().nullable().describe("The field holding how long the item takes; null when none"),
  minutesUnit: z.enum(MINUTES_UNITS).describe('What the "minutes" field counts: minutes, seconds or hours; "minutes" when there is no such field'),
  url: z.string().nullable().describe('A link to the item, as a template over fields, e.g. "https://example.com/p/{slug}"; null when none'),
  solutionUrl: z.string().nullable().describe('A link to its solution, as a template over fields, e.g. "https://example.com/v/{video}"; null when none'),
  subset: z
    .object({ field: z.string(), equals: z.array(z.string()) })
    .nullable()
    .describe('When the source is a named part of the file: the field that marks it and the values that mean "in" (e.g. ["true"]); null for the whole file'),
});
export type FieldMapping = z.infer<typeof fieldMappingSchema>;

/** A field's value on a record: a dot path into it, or `../name` for the object it sits in. Null for no value or an object. */
export function fieldValue(record: DataRecord, field: string | null | undefined): string | null {
  const path = field?.trim();
  if (!path) return null;
  let value: unknown = record.value;
  let rest = path;
  if (rest.startsWith("../")) {
    value = record.parent;
    rest = rest.slice(3);
  }
  for (const key of rest.split(".")) {
    if (!isPlainObject(value)) return null;
    value = value[key];
  }
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * A template filled from a record (`https://host/p/{slug}`, or `{link}` for a field holding a whole link); null when a
 * field it names has no value or the result is not https.
 */
export function fillTemplate(template: string | null | undefined, record: DataRecord): string | null {
  const t = template?.trim();
  if (!t) return null;
  let missing = false;
  const filled = t.replace(/\{([^{}]+)\}/g, (_, field: string) => {
    const value = fieldValue(record, field);
    if (value === null) missing = true;
    return value === null ? "" : encodeURI(value);
  });
  return !missing && filled.toLowerCase().startsWith("https://") ? filled : null;
}

/**
 * Every record of the set the mapping names, in file order, kept to the subset it names, as item drafts. Null when the
 * mapping names no set the file has or the subset field is on no record. The drafts still go through `validateItemList`.
 */
export function applyMapping(file: DataFile, mapping: FieldMapping): ItemDraft[] | null {
  if (!mapping.found) return null;
  const set = file.kind === "csv" ? file.sets[0] : file.sets.find((s) => s.path === (mapping.path ?? "").trim());
  if (!set) return null;
  let records = set.records;
  if (mapping.subset) {
    const { field, equals } = mapping.subset;
    const want = new Set(equals.map((v) => v.trim().toLowerCase()));
    if (!records.some((r) => fieldValue(r, field) !== null)) return null;
    records = records.filter((r) => want.has(fieldValue(r, field)?.toLowerCase() ?? ""));
  }
  const perUnit = PER_UNIT[mapping.minutesUnit] ?? 1;
  return records.map((r) => {
    const minutes = Number(fieldValue(r, mapping.minutes)) * perUnit;
    return {
      title: fieldValue(r, mapping.title) ?? "",
      number: fieldValue(r, mapping.number),
      group: fieldValue(r, mapping.group),
      difficulty: fieldValue(r, mapping.difficulty),
      url: fillTemplate(mapping.url, r),
      solutionUrl: fillTemplate(mapping.solutionUrl, r),
      minutes: Number.isFinite(minutes) && fieldValue(r, mapping.minutes) !== null ? minutes : null,
    };
  });
}
