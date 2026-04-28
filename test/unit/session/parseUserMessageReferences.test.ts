import { describe, expect, it } from "vitest";

import { serializeDiffCommentReference } from "../../../apps/web/src/features/session/lib/parseDiffCommentTags";
import { serializeInspectElement } from "../../../apps/web/src/features/session/lib/parseInspectTags";
import { parseUserMessageReferences } from "../../../apps/web/src/features/session/lib/parseUserMessageReferences";

describe("parseUserMessageReferences", () => {
  const inspect = serializeInspectElement({
    ref: "deus-1",
    tagName: "BUTTON",
    path: "body > main > button",
    innerText: "Save",
    innerHTML: "<span>A > B</span>",
  });
  const diffComment = serializeDiffCommentReference({
    file: "apps/web/src/App.tsx",
    line: 42,
    side: "addition",
    text: "Please rename <Thing> & keep > handling",
  });

  it("preserves order for mixed inspect and diff-comment references", () => {
    const segments = parseUserMessageReferences(`${inspect}\n\nReview this\n\n${diffComment}`);

    expect(segments.map((segment) => segment.type)).toEqual(["inspect", "text", "diff-comment"]);
    expect(segments[0]).toMatchObject({
      type: "inspect",
      element: { path: "body > main > button", innerHTML: "<span>A > B</span>" },
    });
    expect(segments[1]).toEqual({ type: "text", text: "\n\nReview this\n\n" });
    expect(segments[2]).toMatchObject({
      type: "diff-comment",
      comment: { file: "apps/web/src/App.tsx", line: 42, side: "addition" },
    });
  });

  it("parses escaped inspect tags without decoding attribute delimiters too early", () => {
    const escapedInspect = inspect.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const segments = parseUserMessageReferences(escapedInspect);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      type: "inspect",
      element: {
        path: "body > main > button",
        innerHTML: "<span>A > B</span>",
        innerText: "Save",
      },
    });
  });

  it("parses inspect refs before legacy markdown diff comments", () => {
    const legacyDiff = [
      "### 💬 Diff comment",
      "- **File:** `apps/web/src/App.tsx`",
      "- **Line:** 42 (addition)",
      "Please fix this",
    ].join("\n");
    const segments = parseUserMessageReferences(`${inspect}\n\n${legacyDiff}`);

    expect(segments.map((segment) => segment.type)).toEqual(["inspect", "text", "diff-comment"]);
    expect(segments[2]).toMatchObject({
      type: "diff-comment",
      comment: { file: "apps/web/src/App.tsx", line: 42, text: "Please fix this" },
    });
  });

  it("keeps plain text plain when there are no reference tags", () => {
    expect(parseUserMessageReferences("hello world")).toEqual([]);
  });
});
