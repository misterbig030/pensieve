/** The longest short title, its ellipsis included. */
const MAX_SHORT = 44;

/** "system-design-primer" → "System Design Primer"; a word that already has capitals keeps them ("NeetCode"). */
function spacedRepoName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * A material's title as a compact label: the Covers chips, day cards and table rows. A GitHub page reads as its repo
 * name; any other title drops its subtitle, site name and trailing bracketed note, then is cut at a word. The full
 * title stays the material's own (the gate checks it), shown in full in the materials list and in tooltips.
 */
export function shortTitle(title: string): string {
  const t = title.trim();
  const repo = /^GitHub - [^/\s]+\/([^\s:/]+)/.exec(t);
  if (repo) return spacedRepoName(repo[1]!);
  const main = t.split(/:\s|\s[|·–—-]\s/)[0]!.trim();
  // A main title of a letter or two ("C: A Reference Manual") says too little alone.
  let short = main.length >= 4 ? main : t;
  short = short.replace(/\s*[([][^)\]]*[)\]]$/, "").trim() || short;
  if (short.length <= MAX_SHORT) return short;
  const cut = short.slice(0, MAX_SHORT - 1);
  const atWord = cut.slice(0, cut.lastIndexOf(" ")).trim();
  return `${atWord || cut}…`;
}
