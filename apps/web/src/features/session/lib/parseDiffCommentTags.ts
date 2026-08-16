import { escapeTagValue, parseTagAttributes, unescapeTagValue } from "./messageTagCodec";

export interface DiffCommentReference {
  file: string;
  line: number;
  side: "addition" | "deletion";
  text: string;
}

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
