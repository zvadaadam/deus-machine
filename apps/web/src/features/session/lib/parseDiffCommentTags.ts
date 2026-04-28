import { escapeTagValue, parseTagAttributes, unescapeTagValue } from "./messageTagCodec";

export interface DiffCommentReference {
  file: string;
  line: number;
  side: "addition" | "deletion";
  text: string;
}

export type DiffCommentSegment = string | DiffCommentReference;

export function serializeDiffCommentReference(reference: DiffCommentReference): string {
  return `<diff-comment file="${escapeTagValue(reference.file)}" line="${reference.line}" side="${reference.side}">${escapeTagValue(reference.text)}</diff-comment>`;
}

export function diffCommentReferenceFromTag(
  attrString: string,
  encodedText: string
): DiffCommentReference {
  const attrs = parseTagAttributes(attrString);
  const line = Number.parseInt(attrs.line ?? "", 10);
  return {
    file: attrs.file ?? "file",
    line: Number.isFinite(line) ? line : 0,
    side: attrs.side === "deletion" ? "deletion" : "addition",
    text: unescapeTagValue(encodedText),
  };
}

export function parseLegacyDiffCommentReference(text: string):
  | {
      before: string;
      comment: DiffCommentReference;
    }
  | undefined {
  const legacyMatch = text.match(/(?:^|\n)### 💬 Diff comment\s*\n/);
  if (!legacyMatch || legacyMatch.index === undefined) return undefined;

  const before = text.slice(0, legacyMatch.index);
  const legacyStart = legacyMatch.index + (legacyMatch[0].startsWith("\n") ? 1 : 0);
  const lines = text.slice(legacyStart).split("\n");
  const fileMatch = lines[1]?.match(/^- \*\*File:\*\* `([^`]+)`\s*$/);
  const lineMatch = lines[2]?.match(/^- \*\*Line:\*\* (\d+) \((addition|deletion)\)\s*$/);
  if (!fileMatch || !lineMatch) return undefined;

  return {
    before,
    comment: {
      file: fileMatch[1],
      line: Number.parseInt(lineMatch[1], 10),
      side: lineMatch[2] as "addition" | "deletion",
      text: lines.slice(3).join("\n").trimStart(),
    },
  };
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

    segments.push(diffCommentReferenceFromTag(match[1], match[2]));

    lastIndex = match.index + match[0].length;
  }

  if (segments.length === 0) {
    const legacyDiffComment = parseLegacyDiffCommentReference(text);
    if (!legacyDiffComment) return [];

    const legacySegments: DiffCommentSegment[] = [];
    if (legacyDiffComment.before) legacySegments.push(legacyDiffComment.before);
    legacySegments.push(legacyDiffComment.comment);
    return legacySegments;
  }

  if (lastIndex < text.length) {
    segments.push(text.slice(lastIndex));
  }
  return segments;
}
