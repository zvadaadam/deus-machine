// toEngineInput: deus's frontend serializes attachment prompts as a JSON array
// of Anthropic content blocks in the prompt string; the handler must translate
// them into canonical PartInputs (and leave everything else untouched).
import { describe, expect, it } from "vitest";
import { toEngineInput } from "../../../src/services/agent/run-config";

describe("toEngineInput", () => {
  it("passes plain prompts through untouched", () => {
    expect(toEngineInput("hello")).toBe("hello");
    expect(toEngineInput("")).toBe("");
  });

  it("passes '['-prefixed NON-JSON through untouched (markdown links etc.)", () => {
    const prompt = "[see this](https://example.com) — thoughts?";
    expect(toEngineInput(prompt)).toBe(prompt);
  });

  it("translates text + base64-image block arrays", () => {
    const prompt = JSON.stringify([
      { type: "text", text: "what is in this screenshot?" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
    ]);
    expect(toEngineInput(prompt)).toEqual([
      { type: "text", text: "what is in this screenshot?" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
    ]);
  });

  it("translates URL-sourced image blocks", () => {
    const prompt = JSON.stringify([
      { type: "image", source: { type: "url", url: "https://x/y.png", media_type: "image/png" } },
    ]);
    expect(toEngineInput(prompt)).toEqual([
      { type: "image", url: "https://x/y.png", mimeType: "image/png" },
    ]);
  });

  it("falls back to the raw string when the array holds unknown block types", () => {
    const prompt = JSON.stringify([{ type: "document", source: {} }]);
    expect(toEngineInput(prompt)).toBe(prompt);
  });

  it("falls back to the raw string for JSON arrays that are not content blocks", () => {
    expect(toEngineInput("[1, 2, 3]")).toBe("[1, 2, 3]");
    expect(toEngineInput("[]")).toBe("[]");
  });
});

describe("withoutImageParts (harnesses without negotiated image support)", () => {
  it("replaces image parts with an explicit marker, keeps text", async () => {
    const { withoutImageParts } = await import("../../../src/services/agent/run-config");
    const out = withoutImageParts([
      { type: "text", text: "look:" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    expect(out).toEqual([
      { type: "text", text: "look:" },
      {
        type: "text",
        text: "[attached image omitted — this model harness does not support image input]",
      },
    ]);
  });

  it("passes plain strings through", async () => {
    const { withoutImageParts } = await import("../../../src/services/agent/run-config");
    expect(withoutImageParts("hi")).toBe("hi");
  });
});
