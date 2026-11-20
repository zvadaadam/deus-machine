import { describe, expect, it } from "vitest";
import { screenshotWords } from "@/features/session/lib/screenshotWords";

const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const marker = { type: "text", text: "[Image: source: /Users/me/.claude/x/tool-results/a.png]" };
const words = { type: "text", text: "Screenshot of https://example.com/" };

describe("a Browser Screenshot card's words", () => {
  it("leave out Claude Code's block naming where it saved the picture, beside the image", () => {
    expect(screenshotWords([image, marker, words], true)).toEqual([image, words]);
  });

  it("keep the same text inside the tool's own sentence", () => {
    const own = { type: "text", text: `Screenshot of ${marker.text} as the page wrote it` };
    expect(screenshotWords([image, own], true)).toEqual([image, own]);
  });

  it("leave a result with no image as it is", () => {
    expect(screenshotWords([marker, words], false)).toEqual([marker, words]);
  });
});
