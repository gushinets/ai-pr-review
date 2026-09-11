// This workspace is central policy, never selected by PR-controlled metadata.
const LINEAR_ISSUE_URL =
  /^https:\/\/linear\.app\/paveldik\/issue\/(ANY-[1-9][0-9]*)(?:\/[a-zA-Z0-9_-]+)?$/;

export function parsePrMetadata(title: string, body: string | null): string | null {
  if (!/^ANY-[1-9][0-9]* - .+\S$/.test(title) || /[\r\n]/.test(title)) return null;
  const key = title.slice(0, title.indexOf(" "));
  let fence: { marker: string; length: number } | undefined;
  let htmlEnd: RegExp | undefined;
  let sections = 0;
  let inSection = false;
  const sectionLines: string[] = [];
  for (const line of (body ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence || marker || htmlEnd || /^(?: {4}|\t)/.test(line)) sectionLines.push("");
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.marker &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      if (marker[1]![0] === "`" && marker[2]!.includes("`")) continue;
      fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      continue;
    }
    if (htmlEnd) {
      if (htmlEnd.test(line)) htmlEnd = undefined;
      continue;
    }
    const rawTag = /^ {0,3}<(pre|script|style|textarea)(?:\s|>)/i.exec(line);
    if (rawTag) {
      const end = new RegExp(`</${rawTag[1]!}>`, "i");
      if (!end.test(line)) htmlEnd = end;
      continue;
    }
    if (/^ {0,3}<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*|\s*\/?)>/.test(line)) {
      htmlEnd = /^\s*$/;
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) continue;
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading && heading[1]!.length <= 2) {
      inSection = heading[1] === "##" && heading[2] === "Linear issue";
      if (inSection) sections++;
    }
    if (inSection) sectionLines.push(line);
  }
  // Code spans can cross newlines, but not paragraph boundaries; delimiter runs must match exactly.
  const rendered = sectionLines
    .join("\n")
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ""))
    .join("\n");
  const urls: string[] = [];
  for (const match of rendered.matchAll(/https?:\/\//g)) {
    const start = match.index;
    const linkDestination = /\]\([ \t\n]*$/.test(rendered.slice(0, start));
    let end = start;
    let parentheses = 0;
    for (; end < rendered.length; end++) {
      const character = rendered[end]!;
      if (/[\s<>`]/.test(character)) break;
      if (linkDestination && character === ")" && parentheses === 0) break;
      if (character === "(") parentheses++;
      if (character === ")") parentheses--;
    }
    // Keep balanced parentheses and other invalid suffixes, rather than accepting a valid prefix.
    urls.push(rendered.slice(start, end));
  }
  if (sections !== 1 || urls.length !== 1) return null;
  return LINEAR_ISSUE_URL.exec(urls[0]!)?.[1] === key ? key : null;
}
