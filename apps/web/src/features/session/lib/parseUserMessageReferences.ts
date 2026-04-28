import type { DiffCommentReference } from "./parseDiffCommentTags";
import {
  diffCommentReferenceFromTag,
  parseLegacyDiffCommentReference,
} from "./parseDiffCommentTags";
import type { InspectElement } from "./parseInspectTags";
import { inspectElementFromTag } from "./parseInspectTags";
import { normalizeEscapedInspectTags } from "./messageTagCodec";

export type UserMessageReferenceSegment =
  | { type: "text"; text: string }
  | { type: "inspect"; element: InspectElement }
  | { type: "diff-comment"; comment: DiffCommentReference };

const REFERENCE_TAG_REGEX = /<(inspect|diff-comment)\s+((?:[^"'>]|"[^"]*")*)>([\s\S]*?)<\/\1>/g;

export function parseUserMessageReferences(text: string): UserMessageReferenceSegment[] {
  const source = normalizeEscapedInspectTags(text);
  const segments: UserMessageReferenceSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = REFERENCE_TAG_REGEX.exec(source)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: source.slice(lastIndex, match.index) });
    }

    if (match[1] === "inspect") {
      segments.push({ type: "inspect", element: inspectElementFromTag(match[2], match[3]) });
    } else {
      segments.push({
        type: "diff-comment",
        comment: diffCommentReferenceFromTag(match[2], match[3]),
      });
    }

    lastIndex = match.index + match[0].length;
  }

  const remainingText = lastIndex < source.length ? source.slice(lastIndex) : "";
  const legacyDiffComment = parseLegacyDiffCommentReference(remainingText);
  if (legacyDiffComment) {
    if (legacyDiffComment.before) {
      segments.push({ type: "text", text: legacyDiffComment.before });
    }
    segments.push({ type: "diff-comment", comment: legacyDiffComment.comment });
    return segments;
  }

  if (segments.length === 0) return [];
  if (remainingText) segments.push({ type: "text", text: remainingText });
  return segments;
}
