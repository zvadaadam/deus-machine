export interface DiffCommentReference {
  file: string;
  line: number;
  side: "addition" | "deletion";
  text: string;
}

export type DiffCommentSegment = string | DiffCommentReference;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z][\w-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrString)) !== null) {
    attrs[match[1]] = unescapeAttr(match[2]);
  }
  return attrs;
}

export function serializeDiffCommentReference(reference: DiffCommentReference): string {
  return `<diff-comment file="${escapeAttr(reference.file)}" line="${reference.line}" side="${reference.side}">${escapeAttr(reference.text)}</diff-comment>`;
}

export function parseDiffCommentTags(text: string): DiffCommentSegment[] {
  const tagRegex = /<diff-comment\s+((?:[^"'>]|"[^"]*")*)>([\s\S]*?)<\/diff-comment>/g;
  const segments: DiffCommentSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push(text.slice(lastIndex, match.index));
    }

    const attrs = parseAttributes(match[1]);
    const line = Number.parseInt(attrs.line ?? "", 10);
    segments.push({
      file: attrs.file ?? "file",
      line: Number.isFinite(line) ? line : 0,
      side: attrs.side === "deletion" ? "deletion" : "addition",
      text: unescapeAttr(match[2]),
    });

    lastIndex = match.index + match[0].length;
  }

  if (segments.length === 0) {
    const legacyMatch = text.match(/(?:^|\n)### 💬 Diff comment\s*\n/);
    if (!legacyMatch || legacyMatch.index === undefined) return [];

    const before = text.slice(0, legacyMatch.index);
    const legacyStart = legacyMatch.index + (legacyMatch[0].startsWith("\n") ? 1 : 0);
    const lines = text.slice(legacyStart).split("\n");
    const fileMatch = lines[1]?.match(/^- \*\*File:\*\* `([^`]+)`\s*$/);
    const lineMatch = lines[2]?.match(/^- \*\*Line:\*\* (\d+) \((addition|deletion)\)\s*$/);
    if (!fileMatch || !lineMatch) return [];

    const legacySegments: DiffCommentSegment[] = [];
    if (before) legacySegments.push(before);
    legacySegments.push({
      file: fileMatch[1],
      line: Number.parseInt(lineMatch[1], 10),
      side: lineMatch[2] as "addition" | "deletion",
      text: lines.slice(3).join("\n").trimStart(),
    });
    return legacySegments;
  }

  if (lastIndex < text.length) {
    segments.push(text.slice(lastIndex));
  }
  return segments;
}
