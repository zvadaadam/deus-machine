// toEngineInput: the composer serializes attachment-bearing prompts as a JSON
// array of canonical PartInputs, which the engine's own `parseAgentInput`
// validates. Everything deus still owns is DISAMBIGUATION — telling structured
// input apart from prose that merely starts with "[" — because deus's wire
// carries the prompt as one string. Part validity itself belongs to the
// engine's schema and is tested there.
import { describe, expect, it, vi } from "vitest";
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

  it("keeps canonical `file` parts (the composer's attachment path, not just images)", () => {
    const parts = [
      { type: "file", data: "AAAA", mimeType: "application/pdf", filename: "spec.pdf" },
    ];
    expect(toEngineInput(JSON.stringify(parts))).toEqual(parts);
  });

  // ---- disambiguation: prose that merely starts with "[" ----

  it("sends JSON arrays that are not parts as text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(toEngineInput("[1, 2, 3]")).toBe("[1, 2, 3]");
    expect(toEngineInput('["just", "strings"]')).toBe('["just", "strings"]');
    expect(toEngineInput(JSON.stringify([{ type: "document", source: {} }]))).toBe(
      JSON.stringify([{ type: "document", source: {} }])
    );
    warn.mockRestore();
  });

  it("sends the empty array as text (it carries no input)", () => {
    expect(toEngineInput("[]")).toBe("[]");
  });

  it("sends an almost-canonical array as text rather than mangling it, and says so", () => {
    // An image with no payload fails the schema's refinement. Falling back is
    // the disambiguation rule, but a composer bug looks exactly the same from
    // here — so it is logged rather than silently reinterpreted.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prompt = JSON.stringify([{ type: "image", mimeType: "image/png" }]);
    expect(toEngineInput(prompt)).toBe(prompt);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
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
