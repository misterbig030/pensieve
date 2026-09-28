import type { GuardedResponse } from "./egress";

/** What `fetchSource` hands the model and the gate: the page's own claims about itself, plus readable text. */
export interface PageInfo {
  finalUrl: string;
  title: string | null;
  ogTitle: string | null;
  h1: string | null;
  author: string | null;
  published: string | null;
  /** Readable text, cut to roughly 4k tokens. */
  text: string;
}

/** About 4k tokens of English. */
export const MAX_TEXT_CHARS = 16_000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function clean(text: string | null | undefined): string | null {
  if (!text) return null;
  const out = decodeEntities(text.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return out.length > 0 ? out.slice(0, 300) : null;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  }
  return out;
}

/** Meta tags by their `name` or `property`, lower-cased; the first occurrence wins. */
function metaTags(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? "").toLowerCase();
    if (key && a.content !== undefined && !map.has(key)) map.set(key, a.content);
  }
  return map;
}

function firstMeta(meta: Map<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = clean(meta.get(key));
    if (value) return value;
  }
  return null;
}

/** Strips everything that is not reading matter, then tags; keeps paragraph breaks as newlines. */
export function htmlToText(html: string): string {
  let body = html;
  const main = html.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (main && main[2].length > 500) body = main[2];
  body = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote|\/pre)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT_CHARS);
}

/** Removes markup that can hold tag-like text (scripts, styles, comments) so it is never mistaken for the page. */
function stripCode(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ");
}

export function extractHtml(raw: string, finalUrl: string): PageInfo {
  const html = stripCode(raw);
  const meta = metaTags(html);
  const title = clean(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const h1 = clean(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  return {
    finalUrl,
    title,
    ogTitle: firstMeta(meta, ["og:title", "citation_title", "twitter:title", "dc.title"]),
    h1,
    author: firstMeta(meta, ["author", "citation_author", "article:author", "dc.creator", "book:author"]),
    published: firstMeta(meta, [
      "article:published_time",
      "citation_publication_date",
      "citation_date",
      "dc.date",
      "date",
      "book:release_date",
    ]),
    text: htmlToText(html),
  };
}

/** Reads a PDF's document-info Title and Author when they are stored as plain strings. The body text is not read. */
export function extractPdf(bytes: Uint8Array, finalUrl: string): PageInfo {
  const raw = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.byteLength, 2 * 1024 * 1024)));
  const field = (name: string): string | null => {
    const literal = raw.match(new RegExp(`/${name}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`));
    if (literal) return clean(literal[1].replace(/\\([()\\])/g, "$1"));
    const hex = raw.match(new RegExp(`/${name}\\s*<([0-9a-fA-F\\s]+)>`));
    if (hex) return clean(decodePdfHex(hex[1]));
    return null;
  };
  return { finalUrl, title: field("Title"), ogTitle: null, h1: null, author: field("Author"), published: null, text: "" };
}

function decodePdfHex(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("latin1").decode(bytes);
}

export function extractText(text: string, finalUrl: string): PageInfo {
  const firstLine = text.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
  return {
    finalUrl,
    title: firstLine ? firstLine.slice(0, 200) : null,
    ogTitle: null,
    h1: null,
    author: null,
    published: null,
    text: text.slice(0, MAX_TEXT_CHARS),
  };
}

function decode(bytes: Uint8Array, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Turns a guarded response into page info, by content type. */
export function extractPage(res: GuardedResponse): PageInfo {
  if (res.contentType === "application/pdf") return extractPdf(res.body, res.finalUrl);
  const text = decode(res.body, res.charset);
  if (res.contentType === "text/plain") return extractText(text, res.finalUrl);
  return extractHtml(text, res.finalUrl);
}
