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
