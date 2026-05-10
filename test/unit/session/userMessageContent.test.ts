import { describe, expect, it } from "vitest";

import { extractTextFromUserMessageContent } from "../../../apps/web/src/features/session/lib/userMessageContent";

describe("extractTextFromUserMessageContent", () => {
  it("returns plain text for legacy unencoded content", () => {
    expect(extractTextFromUserMessageContent("hello")).toBe("hello");
  });

  it("returns a JSON string payload as text", () => {
    expect(extractTextFromUserMessageContent(JSON.stringify("hello"))).toBe("hello");
  });

  it("joins text blocks and ignores image blocks", () => {
    const content = JSON.stringify([
      { type: "text", text: "first" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
      { type: "text", text: "second" },
    ]);

    expect(extractTextFromUserMessageContent(content)).toBe("first\nsecond");
  });
});
