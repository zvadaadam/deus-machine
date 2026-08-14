// toEngineInput: the composer serializes attachment-bearing prompts as a JSON
// array of canonical PartInputs, which the handler forwards verbatim. Rows
// written before that flip hold Anthropic content blocks — those are still
// tolerated (translated), and everything else is left untouched.
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

  // ---- canonical PartInput (what the composer emits today) ----

  it("passes a canonical text + base64-image PartInput array straight through", () => {
    const parts = [
      { type: "text", text: "what is in this screenshot?" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
    ];
    expect(toEngineInput(JSON.stringify(parts))).toEqual(parts);
  });

  it("passes canonical URL-sourced image parts straight through", () => {
    const parts = [{ type: "image", url: "https://x/y.png", mimeType: "image/png" }];
    expect(toEngineInput(JSON.stringify(parts))).toEqual(parts);
  });

  it("preserves optional canonical fields (id, elements, filename)", () => {
    const parts = [
      {
        type: "text",
        id: "p1",
        text: "look at @src/app.ts",
        elements: [{ byteRange: [8, 19], placeholder: "src/app.ts" }],
      },
      { type: "image", data: "AAAA", mimeType: "image/png", filename: "shot.png" },
    ];
    expect(toEngineInput(JSON.stringify(parts))).toEqual(parts);
  });

  it("keeps inline XML inside the text part untouched", () => {
    const text = '<inspect selector="#root">Header</inspect>\n\nfix the spacing';
    const parts = [
      { type: "text", text },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ];
    const out = toEngineInput(JSON.stringify(parts));
    expect(Array.isArray(out) && out[0]).toEqual({ type: "text", text });
  });

  it("drops empty text parts (a text part must be non-empty on the wire)", () => {
    const prompt = JSON.stringify([
      { type: "text", text: "" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    expect(toEngineInput(prompt)).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
  });

  // ---- legacy tolerance (rows written before the composer flip) ----

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
    expect(toEngineInput('["just", "strings"]')).toBe('["just", "strings"]');
  });

  it("falls back to the raw string for an image block with no payload", () => {
    const prompt = JSON.stringify([{ type: "image", mimeType: "image/png" }]);
    expect(toEngineInput(prompt)).toBe(prompt);
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
