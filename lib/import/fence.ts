/** `text` with any closing `</tag>` broken to `</ tag>`, so nothing in it can end a fence early. */
export function fenceText(text: string, tag: string): string {
  return text.replace(new RegExp(`<\\/\\s*${tag}\\s*>`, "gi"), `</ ${tag}>`);
}
