import { describe, expect, it } from "vitest";

import { normalizeIframePayload } from "../src/lib/iframe-rpc.ts";

describe("normalizeIframePayload", () => {
  it("maps batch_design operations string to the editor's input field", () => {
    expect(
      normalizeIframePayload("batch-design", {
        filePath: "/tmp/demo.pen",
        operations: 'screen=I(document,{type:"frame"})',
      })
    ).toEqual({
      filePath: "/tmp/demo.pen",
      operations: 'screen=I(document,{type:"frame"})',
      input: 'screen=I(document,{type:"frame"})',
    });
  });

  it("joins operation arrays for callers that follow the skill examples", () => {
    expect(
      normalizeIframePayload("batch-design", {
        operations: ['screen=I(document,{type:"frame"})', 'title=I(screen,{type:"text"})'],
      })
    ).toMatchObject({
      input: 'screen=I(document,{type:"frame"})\ntitle=I(screen,{type:"text"})',
    });
  });

  it("preserves explicit input and unrelated payloads", () => {
    const payload = { input: "already-normalized", operations: ["ignored"] };
    expect(normalizeIframePayload("batch-design", payload)).toBe(payload);
    expect(normalizeIframePayload("get-editor-state", { operations: ["ignored"] })).toEqual({
      operations: ["ignored"],
    });
  });
});
