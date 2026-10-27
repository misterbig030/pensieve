import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractHtml, extractPdf } from "./extract";
import { isGithubRepoPage, parseOutline, siteLinkCount } from "./outline";

function fixture(name: string): string {
  return gunzipSync(readFileSync(join(__dirname, "__fixtures__", "pages", `${name}.html.gz`))).toString("utf8");
}

const primer = fixture("github-readme");
const hub = fixture("github-hub");
const blog = fixture("blog");
const bookToc = fixture("book-toc");

const githubShell = `<html><body>
  <header><a href="/a/b/issues">Issues</a><a href="/login">Sign in</a></header>
  <div class="file-list"><a href="/a/b/tree/main/src">src</a><a href="/a/b/blob/main/LICENSE">LICENSE</a></div>
  <article class="markdown-body entry-content"></article>
  <footer><a href="/a/b/graphs">Graphs</a></footer>
</body></html>`;

describe("parseOutline", () => {
  it("reads a GitHub README's sections with anchors and words", () => {
    const o = parseOutline(primer, "https://github.com/donnemartin/system-design-primer");
    const lb = o.headings.find((h) => /^load balancer$/i.test(h.title))!;
    expect(lb.anchor).toBe("load-balancer"); // no "user-content-" prefix
    expect(lb.words).toBeGreaterThan(200);
    expect(o.words).toBeGreaterThan(9000);
    expect(o.headings.filter((h) => h.level === 2).length).toBeGreaterThanOrEqual(10);
  });

  it("counts a section's sub-sections in its words, and nothing past the next heading of its level", () => {
    const o = parseOutline(
      `<article class="markdown-body"><h2 id="a">A</h2><p>one two</p><h3 id="a1">A1</h3><p>three four five</p><h2 id="b">B</h2><p>six</p></article>`,
      "https://github.com/a/b",
    );
    expect(o.headings.map((h) => [h.title, h.words])).toEqual([["A", 7], ["A1", 4], ["B", 2]]);
    expect(o.words).toBe(9);
  });

  it("splits a blog post's words among its headings", () => {
    const o = parseOutline(blog, "https://lilianweng.github.io/posts/2023-06-23-agent/");
    const top = o.headings.filter((h) => h.level === Math.min(...o.headings.map((x) => x.level)));
    expect(top.reduce((s, h) => s + h.words, 0)).toBeGreaterThan(o.words * 0.7);
    expect(o.headings.find((h) => h.title === "Task Decomposition")?.anchor).toBe("task-decomposition");
  });

  it("lists a contents page's chapter links", () => {
    const o = parseOutline(bookToc, "https://web.stanford.edu/~jurafsky/slp3/");
    const ngram = o.links.find((l) => /n-?gram/i.test(l.text));
    expect(ngram?.url).toBe("https://web.stanford.edu/~jurafsky/slp3/3.pdf");
  });

  it("percent-decodes a non-ASCII anchor", () => {
    const o = parseOutline(
      `<article class="markdown-body"><div class="markdown-heading"><h2>Кэш</h2><a id="user-content-%D0%BA%D1%8D%D1%88" class="anchor" href="#%D0%BA%D1%8D%D1%88"></a></div><p>x</p></article>`,
      "https://github.com/a/b",
    );
    expect(o.headings[0].anchor).toBe("кэш");
  });

  it("takes a heading's own id, then a link inside it, over nothing", () => {
    const o = parseOutline(
      `<main><h2 id="own">Own</h2><h2><a href="#inner">Inner</a></h2><h2><a href="https://x.test/">Away</a></h2><p>${"word ".repeat(120)}</p></main>`,
      "https://example.com/p",
    );
    expect(o.headings.map((h) => h.anchor)).toEqual(["own", "inner", null]);
  });

  it("keeps navigation links but not same-page, mail or script links", () => {
    const o = parseOutline(
      `<body><nav><a href="/docs/intro">Intro</a></nav><main><a href="#top">top</a><a href="mailto:a@b.c">mail</a><a href="javascript:void(0)">js</a><a href="/docs/intro">Intro</a></main></body>`,
      "https://example.com/docs/",
    );
    expect(o.links).toEqual([{ url: "https://example.com/docs/intro", text: "Intro" }]);
  });

  it("puts each link under the heading it sits in", () => {
    const o = parseOutline(
      `<main><h2 id="a">A</h2><a href="/one">One</a><h3 id="a1">A1</h3><a href="/two">Two</a><h2 id="b">B</h2><a href="/three">Three</a><p>${"w ".repeat(300)}</p></main>`,
      "https://example.com/",
    );
    expect(o.headings.map((h) => h.links.map((l) => l.text))).toEqual([["One", "Two"], ["Two"], ["Three"]]);
  });
});

describe("siteLinkCount", () => {
  it("counts a hub README's links to its own folders", () => {
    const url = "https://github.com/severilov/DL-Audio-AIMasters-Course";
    expect(siteLinkCount(parseOutline(hub, url), url)).toBeGreaterThanOrEqual(6);
  });

  it("does not count GitHub's own chrome as site links", () => {
    expect(siteLinkCount(parseOutline(githubShell, "https://github.com/a/b"), "https://github.com/a/b")).toBe(0);
  });

  it("does not count a README's badge and project-page links as its own files", () => {
    const url = "https://github.com/a/b";
    const badges = ["actions/workflows/ci.yml", "releases", "issues", "pulls", "wiki", "stargazers", "actions", "graphs/contributors"]
      .map((p) => `<a href="https://github.com/a/b/${p}">x</a>`)
      .join("");
    const o = parseOutline(`<article class="markdown-body"><p>${badges}<a href="/a/b/blob/main/x.md">doc</a></p></article>`, url);
    expect(siteLinkCount(o, url)).toBe(1);
  });

  it("counts same-site pages once, not the page itself, not other sites", () => {
    const url = "https://example.com/book/";
    const o = parseOutline(
      `<body><a href="/book/1">1</a><a href="/book/1#x">1 again</a><a href="/book/">self</a><a href="https://www.example.com/about">about</a><a href="https://other.test/">other</a></body>`,
      url,
    );
    expect(siteLinkCount(o, url)).toBe(2);
  });
});

describe("isGithubRepoPage", () => {
  it("is true for a repo and its folders, false for the rest of GitHub", () => {
    expect(isGithubRepoPage("https://github.com/a/b")).toBe(true);
    expect(isGithubRepoPage("https://github.com/a/b/tree/main/lectures")).toBe(true);
    expect(isGithubRepoPage("https://github.com/a/b/blob/main/x.md")).toBe(false);
    expect(isGithubRepoPage("https://github.com/a")).toBe(false);
    expect(isGithubRepoPage("https://github.com/topics/rust")).toBe(false);
    expect(isGithubRepoPage("https://example.com/a/b")).toBe(false);
  });
});

describe("extraction", () => {
  it("puts the outline and site links on PageInfo", () => {
    const p = extractHtml(primer, "https://github.com/donnemartin/system-design-primer");
    expect(p.outline?.words).toBe(p.words);
    expect(p.siteLinks).toBeGreaterThanOrEqual(0);
  });

  it("collapses non-breaking spaces in the readable text", () => {
    expect(extractHtml("<p>a&nbsp;&nbsp;b</p>", "https://example.com/").text).toBe("a b");
  });

  it("measures a non-GitHub page's outline against the same words", () => {
    const p = extractHtml(blog, "https://lilianweng.github.io/posts/2023-06-23-agent/");
    expect(p.outline?.words).toBe(p.words);
  });

  it("counts a PDF's pages, not its page tree", () => {
    const bytes = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj<</Type /Pages /Count 3>>endobj\n2 0 obj<</Type /Page /Parent 1 0 R>>endobj\n3 0 obj<</Type/Page>>endobj\n4 0 obj<< /Type /Page >>endobj",
    );
    expect(extractPdf(bytes, "https://example.com/a.pdf").pages).toBe(3);
  });

  it("leaves a PDF's page count null when no page objects are readable", () => {
    expect(extractPdf(new TextEncoder().encode("%PDF-1.5 compressed"), "https://example.com/a.pdf").pages).toBeNull();
  });
});
