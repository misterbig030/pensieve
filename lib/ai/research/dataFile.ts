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
}

/** Record sets shorter than this are not lists of items. */
const MIN_RECORDS = 3;
const MAX_DEPTH = 3;
/** Records shown to the model from the largest set, and from each other set. */
export const SAMPLE_RECORDS = 20;
const OTHER_SAMPLE_RECORDS = 3;
const MAX_SETS = 4;
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

function jsonSets(root: unknown): RecordSet[] {
  const sets: RecordSet[] = [];
  const add = (path: string, records: DataRecord[]) => {
    if (records.length < MIN_RECORDS) return;
    sets.push({ path, records, keys: keysOf(records.map((r) => r.value)), parentKeys: keysOf(records.map((r) => r.parent).filter(isPlainObject)) });
  };
  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    const objects = objectsIn(value);
    if (objects) {
      add(path, objects.map((o) => ({ value: o, parent: null })));
      // Arrays nested one level in these objects (groups holding their items): gathered across all of them.
      for (const key of keysOf(objects)) {
        const nested: DataRecord[] = [];
        for (const parent of objects) for (const child of objectsIn(parent[key]) ?? []) nested.push({ value: child, parent });
        if (nested.length > 0) add(`${path}[].${key}`, nested);
      }
      return;
    }
    if (isPlainObject(value)) for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key, depth + 1);
  };
  walk(root, "", 0);
  return sets;
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

/** What the model sees of a data file: each record set's path, size and keys, and its first records. */
export function sampleDataFile(file: DataFile): string {
  const sets = [...file.sets].sort((a, b) => b.records.length - a.records.length).slice(0, MAX_SETS);
  const lines: string[] = [];
  sets.forEach((set, i) => {
    if (file.kind === "json") lines.push(`Records at path "${set.path}"${set.path === "" ? " (the top level)" : ""}: ${set.records.length}`);
    else lines.push(`CSV rows: ${set.records.length}`);
    lines.push(`Fields: ${set.keys.join(", ")}`);
    if (set.parentKeys.length > 0) lines.push(`Fields of the object each record sits in (write them as ../field): ${set.parentKeys.join(", ")}`);
    const n = i === 0 ? SAMPLE_RECORDS : OTHER_SAMPLE_RECORDS;
    lines.push(`First ${Math.min(n, set.records.length)} records:`);
    for (const r of set.records.slice(0, n)) {
      const own = JSON.stringify(r.value);
      lines.push(own.length > SAMPLE_RECORD_CHARS ? `${own.slice(0, SAMPLE_RECORD_CHARS)}…` : own);
    }
    lines.push("");
  });
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------------------------------------------
// The mapping

export const fieldMappingSchema = z.object({
  found: z.boolean().describe("True only when this file lists the source's items"),
  path: z.string().nullable().describe('JSON: the path of the records that are the items, exactly as listed; null for CSV'),
  title: z.string().describe("The field holding each item's title"),
  number: z.string().nullable().describe("The field holding the item's own number or label on its site; null when none"),
  group: z.string().nullable().describe("The field holding the item's topic or group; ../field for the object it sits in; null when none"),
  difficulty: z.string().nullable().describe("The field holding easy/medium/hard; null when none"),
  minutes: z.string().nullable().describe("The field holding minutes; null when none"),
  url: z.string().nullable().describe('A link to the item, as a template over fields, e.g. "https://example.com/p/{slug}"; null when none'),
  solutionUrl: z.string().nullable().describe('A link to its solution, as a template over fields, e.g. "https://example.com/v/{video}"; null when none'),
  subset: z
    .object({ field: z.string(), equals: z.string() })
    .nullable()
    .describe('When the source is a named part of the file: the field that marks it and the value that means "in" (e.g. "true"); null for the whole file'),
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
    const want = equals.trim().toLowerCase();
    if (!records.some((r) => fieldValue(r, field) !== null)) return null;
    records = records.filter((r) => fieldValue(r, field)?.toLowerCase() === want);
  }
  return records.map((r) => {
    const minutes = Number(fieldValue(r, mapping.minutes));
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
