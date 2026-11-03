/** A lesson's opening as plain text, for the plan page's preview of it. */

const NOT_PROSE = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||<)/;

function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The first paragraph that isn't a heading, code fence, list, quote or table, with inline markdown stripped and cut at
 * a word boundary to `max` characters (ellipsis included). Empty when the lesson has no such paragraph.
 */
export function firstParagraph(markdown: string, max = 320): string {
  let fenced = false;
  let block: string[] = [];
  for (const line of [...markdown.split("\n"), ""]) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      block = [];
      continue;
    }
    if (fenced) continue;
    if (line.trim() !== "") {
      block.push(line);
      continue;
    }
    if (block.length > 0 && !NOT_PROSE.test(block[0])) {
      const text = plain(block.join(" "));
      if (text) return text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
    }
    block = [];
  }
  return "";
}
