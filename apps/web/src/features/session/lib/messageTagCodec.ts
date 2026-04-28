export function escapeTagValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function unescapeTagValue(value: string): string {
  return value
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

export function parseTagAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z][\w-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrString)) !== null) {
    attrs[match[1]] = unescapeTagValue(match[2]);
  }
  return attrs;
}

export function normalizeEscapedInspectTags(text: string): string {
  if (!text.includes("&lt;inspect")) return text;
  const source = text
    .replace(/&lt;(\/?)inspect/g, "<$1inspect")
    .replace(/<\/inspect&gt;/g, "</inspect>");

  let result = "";
  let cursor = 0;
  let searchIndex = 0;
  while (true) {
    const start = source.indexOf("<inspect", searchIndex);
    if (start === -1) break;

    let inQuote = false;
    let replaced = false;
    for (let index = start + "<inspect".length; index < source.length; index++) {
      if (source[index] === '"') {
        inQuote = !inQuote;
        continue;
      }
      if (inQuote) continue;
      if (source[index] === ">") {
        searchIndex = index + 1;
        replaced = true;
        break;
      }
      if (source.startsWith("&gt;", index)) {
        result += source.slice(cursor, index) + ">";
        cursor = index + "&gt;".length;
        searchIndex = cursor;
        replaced = true;
        break;
      }
    }

    if (!replaced) break;
  }

  return result + source.slice(cursor);
}
