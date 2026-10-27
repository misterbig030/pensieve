import { attrs, clean, countWords, decodeEntities, markupToText, readableRegion, stripChrome, stripCode } from "./extract";
import { canonicalUrl, registrableDomain } from "./verify";

export interface OutlineLink {
  /** Absolute URL. */
  url: string;
  /** Decoded, whitespace-collapsed link text. */
  text: string;
}

export interface OutlineHeading {
  /** 1–6. */
  level: number;
  /** Decoded, whitespace-collapsed. */
  title: string;
  /** The fragment that jumps to this heading: no "#", no "user-content-", percent-decoded. Null when the page gives none. */
  anchor: string | null;
  /** Words of the readable text from this heading to the next heading of the same or higher level, sub-sections included. */
  words: number;
  /** Links inside that span. */
  links: OutlineLink[];
}

export interface PageOutline {
  /** Equals `PageInfo.words` for the same page. */
  words: number;
  /** In document order. */
  headings: OutlineHeading[];
  /** Every link in the body, navigation and sidebars included (GitHub: the README article only). */
  links: OutlineLink[];
}

/** GitHub paths whose second segment is not a repo name. */
const GITHUB_NON_OWNERS = new Set([
  "about", "apps", "collections", "customer-stories", "enterprise", "events", "explore", "features", "issues", "login",
  "marketplace", "new", "notifications", "orgs", "pricing", "pulls", "readme", "resources", "search", "security",
  "settings", "site", "solutions", "sponsors", "topics", "trending",
]);

/** `github.com/{owner}/{repo}` and `github.com/{owner}/{repo}/tree/...`: the pages that show a repo's README beside its file list. */
export function isGithubRepoPage(url: string): boolean {
  return githubRepoOf(url) !== null;
}

/** "owner/repo", lower-cased, for a GitHub repo or folder page; null for anything else. */
function githubRepoOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.hostname.toLowerCase().replace(/^www\./, "") !== "github.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || GITHUB_NON_OWNERS.has(parts[0].toLowerCase())) return null;
  if (parts.length > 2 && parts[2] !== "tree") return null;
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

/** The rendered README: the inside of the first `<article class="markdown-body">`. Null when the page has none. */
function githubReadme(html: string): string | null {
  const open = html.match(/<article\b[^>]*\bclass\s*=\s*(?:"[^"]*|'[^']*)\bmarkdown-body\b[^>]*>/i);
  if (!open || open.index === undefined) return null;
  const start = open.index + open[0].length;
  const end = html.indexOf("</article>", start);
  return html.slice(start, end === -1 ? undefined : end);
}

/** The page's headings, the words under each, and its links, read once from the HTML. */
export function parseOutline(rawHtml: string, finalUrl: string): PageOutline {
  const html = stripCode(rawHtml);
  const github = isGithubRepoPage(finalUrl);
  // On a GitHub repo page everything but the README is GitHub's own chrome and file list.
  let region: string;
  let links: OutlineLink[];
  if (github) {
    region = stripChrome(githubReadme(html) ?? "");
    links = linksIn(region, finalUrl);
  } else {
    region = readableRegion(html);
    const body = html.search(/<body\b/i);
    links = linksIn(body === -1 ? html : html.slice(body), finalUrl);
  }
  return { words: countWords(markupToText(region)), headings: headingsIn(region, finalUrl), links };
}

/** The "#" or "¶" link many sites tuck inside a heading to link to it; it is not part of the title. */
const PERMALINK = /<a\b[^>]*\bhref\s*=\s*["']#[^"']*["'][^>]*>\s*(?:<[^>]+>\s*)*[^\p{L}\p{N}<\s]{0,3}\s*<\/a>/giu;

const HEADING = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;

function headingsIn(region: string, finalUrl: string): OutlineHeading[] {
  const found: { level: number; title: string; anchor: string | null; start: number }[] = [];
  for (const m of region.matchAll(HEADING)) {
    const title = clean(m[3].replace(PERMALINK, " "));
    if (!title) continue;
    const after = region.slice(m.index + m[0].length, m.index + m[0].length + 400);
    found.push({ level: Number(m[1]), title, anchor: anchorOf(m[2], m[3], after), start: m.index });
  }
  // Each heading owns the stretch up to the next heading, so words and links are measured per stretch, then summed over a section.
  const stretches = found.map((h, i) => {
    const part = region.slice(h.start, found[i + 1]?.start ?? region.length);
    return { words: countWords(markupToText(part)), links: linksIn(part, finalUrl) };
  });
  return found.map((h, i) => {
    let end = i + 1;
    while (end < found.length && found[end].level > h.level) end++;
    const span = stretches.slice(i, end);
    return {
      level: h.level,
      title: h.title,
      anchor: h.anchor,
      words: span.reduce((sum, s) => sum + s.words, 0),
      links: dedupe(span.flatMap((s) => s.links)),
    };
  });
}

/** The heading's own `id`; failing that the `id` or `#` link of the first `<a>` inside it or straight after it (GitHub's sibling `<a class="anchor">`). */
function anchorOf(headingAttrs: string, inner: string, after: string): string | null {
  const own = attrs(`<h ${headingAttrs}>`).id;
  if (own) return normalizeAnchor(own);
  for (const m of inner.matchAll(/<a\b([^>]*)>/gi)) {
    const found = anchorFromLink(m[1]);
    if (found) return found;
  }
  const next = after.match(/^\s*<a\b([^>]*)>/i);
  return next ? anchorFromLink(next[1]) : null;
}

function anchorFromLink(linkAttrs: string): string | null {
  const a = attrs(`<a ${linkAttrs}>`);
  if (a.href?.startsWith("#")) return normalizeAnchor(a.href.slice(1));
  return a.id ? normalizeAnchor(a.id) : null;
}

function normalizeAnchor(raw: string): string | null {
  let value = decodeEntities(raw);
  try {
    value = decodeURIComponent(value);
  } catch {
    // Not valid percent-encoding: keep it as written.
  }
  value = value.replace(/^user-content-/, "");
  return value || null;
}

/** Every http(s) link in the markup, resolved against the page's URL. Same-page `#` links and mail or script links are left out. */
function linksIn(markup: string, finalUrl: string): OutlineLink[] {
  const out: OutlineLink[] = [];
  for (const m of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attrs(`<a ${m[1]}>`).href?.trim();
    if (!href || href.startsWith("#")) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(href), finalUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    out.push({ url: url.href, text: clean(m[2]) ?? "" });
  }
  return dedupe(out);
}

/** The same link with the same text twice adds nothing. */
function dedupe(links: OutlineLink[]): OutlineLink[] {
  const seen = new Set<string>();
  return links.filter((l) => {
    const key = `${l.url}\n${l.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Paths that end in an image: a picture is not a page to read, however many a README shows. A PDF is a page. */
const IMAGE_PATH = /\.(?:png|jpe?g|gif|svg|webp|ico|bmp)$/i;

/**
 * How many distinct other pages of the page's own site it links to. For a GitHub repo that is the repo's own files and
 * folders (blob and tree links, not its issues, actions or release pages); elsewhere it is any page on the same
 * registrable domain. Links to images are not pages and are not counted.
 */
export function siteLinkCount(outline: PageOutline, finalUrl: string): number {
  const self = canonicalUrl(finalUrl);
  const repo = githubRepoOf(finalUrl);
  const domain = registrableDomain(hostnameOf(finalUrl));
  const targets = new Set<string>();
  for (const link of outline.links) {
    const target = canonicalUrl(link.url);
    if (!target || target === self || IMAGE_PATH.test(new URL(target).pathname)) continue;
    if (repo) {
      const t = new URL(target);
      if (t.hostname === "github.com" && (t.pathname.toLowerCase().startsWith(`/${repo}/blob/`) || t.pathname.toLowerCase().startsWith(`/${repo}/tree/`))) targets.add(target);
    } else if (domain && registrableDomain(hostnameOf(target)) === domain) {
      targets.add(target);
    }
  }
  return targets.size;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
