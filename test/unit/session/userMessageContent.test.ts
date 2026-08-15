/**
 * The composer↔bubble round trip.
 *
 * The composer emits the canonical `PartInput` vocabulary; the bubble renders
 * two producers (engine `Part`s — the echo AND the composer's own optimistic
 * bubble — plus LEGACY Anthropic block `content`) through one normalizer.
 * These tests pin both ends so a shape drift on either side fails here rather
 * than in the UI.
 */
import { describe, expect, it } from "vitest";

import {
  buildImageParts,
  buildMessageContent,
  type ImageAttachment,
} from "../../../apps/web/src/features/session/lib/imageAttachments";
import { createOptimisticUserMessage } from "../../../apps/web/src/features/session/lib/optimisticMessage";
import { readUserMessageContent } from "../../../apps/web/src/features/session/lib/userMessageContent";
import type { Part } from "../../../shared/protocol-types";

function attachment(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: "att-1",
    file: undefined as unknown as File,
    preview: "data:image/png;base64,AAAA",
    type: "image/png",
    ...overrides,
  };
}

function textPart(text: string, partIndex = 0): Part {
  return {
    type: "text",
    id: `text-${partIndex}`,
    sessionId: "session-1",
    messageId: "message-1",
    partIndex,
    text,
    state: "done",
  };
}

describe("buildImageParts", () => {
  it("emits canonical image PartInputs — flat data + mimeType, no Anthropic source", () => {
    expect(buildImageParts([attachment({ type: "image/jpeg" })])).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
    ]);
  });

  it("tolerates a bare base64 preview with no data-URL prefix", () => {
    expect(buildImageParts([attachment({ preview: "BBBB" })])).toEqual([
      { type: "image", data: "BBBB", mimeType: "image/png" },
    ]);
  });

  it("returns null with no attachments so the caller sends plain text", () => {
    expect(buildImageParts([])).toBeNull();
  });
});

describe("buildMessageContent (what the composer puts on the wire)", () => {
  it("keeps a text-only send a bare string — a string IS a canonical AgentInput", () => {
    expect(buildMessageContent("ship it", [])).toBe("ship it");
    expect(buildMessageContent("", [])).toBe("");
  });

  it("emits canonical PartInput JSON when images are attached", () => {
    const content = buildMessageContent("what is this?", [attachment()]);
    expect(JSON.parse(content)).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  it("omits the text part when only images were staged", () => {
    const content = buildMessageContent("", [attachment()]);
    expect(JSON.parse(content)).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
  });

  it("carries inline XML verbatim inside the text part (TextBlock parses it later)", () => {
    const text = '<inspect selector="#root">Header</inspect>\n\nfix the spacing';
    const content = buildMessageContent(text, [attachment()]);
    expect(JSON.parse(content)[0]).toEqual({ type: "text", text });
  });
});

describe("readUserMessageContent — engine echo parts (new rows)", () => {
  it("reads text and base64 image parts", () => {
    const imagePart: Part = {
      type: "image",
      id: "img-1",
      sessionId: "session-1",
      messageId: "message-1",
      partIndex: 1,
      data: "AAAA",
      mimeType: "image/png",
    };
    expect(readUserMessageContent({ parts: [textPart("hello"), imagePart] })).toEqual({
      texts: ["hello"],
      images: ["data:image/png;base64,AAAA"],
    });
  });

  it("reads URL-sourced image parts", () => {
    const imagePart: Part = {
      type: "image",
      id: "img-1",
      sessionId: "session-1",
      messageId: "message-1",
      partIndex: 0,
      url: "https://x/y.png",
      mimeType: "image/png",
    };
    expect(readUserMessageContent({ parts: [imagePart] }).images).toEqual(["https://x/y.png"]);
  });

  it("skips unknown parts instead of throwing (Law 6)", () => {
    const unknown = { id: "u-1", type: "future", raw: {} } as never;
    expect(readUserMessageContent({ parts: [unknown, textPart("hi")] })).toEqual({
      texts: ["hi"],
      images: [],
    });
  });

  it("prefers parts over content when both are present", () => {
    const row = {
      parts: [textPart("from the echo")],
      content: JSON.stringify([{ type: "text", text: "from the composer" }]),
    };
    expect(readUserMessageContent(row).texts).toEqual(["from the echo"]);
  });
});

describe("readUserMessageContent — the composer's optimistic bubble", () => {
  it("renders through `parts`, not a JSON content blob — one producer, not two", () => {
    const content = buildMessageContent("what is this?", [attachment({ type: "image/jpeg" })]);
    const bubble = createOptimisticUserMessage({ sessionId: "s1", turnId: "t1", content });

    expect(bubble.content).toBeNull();
    expect(readUserMessageContent(bubble)).toEqual({
      texts: ["what is this?"],
      images: ["data:image/jpeg;base64,AAAA"],
    });
  });

  it("renders a text-only send (the composer sends a bare string)", () => {
    const bubble = createOptimisticUserMessage({
      sessionId: "s1",
      turnId: "t1",
      content: "just a prompt",
    });
    expect(readUserMessageContent(bubble)).toEqual({ texts: ["just a prompt"], images: [] });
  });

  it("carries the send's turn id, so the echo can replace it", () => {
    const bubble = createOptimisticUserMessage({ sessionId: "s1", turnId: "t-7", content: "hi" });
    expect(bubble.turn_id).toBe("t-7");
    expect(bubble.role).toBe("user");
  });
});

describe("readUserMessageContent — content JSON", () => {
  it("still renders LEGACY Anthropic blocks from rows written before the flip", () => {
    const content = JSON.stringify([
      { type: "text", text: "old row" },
      { type: "image", source: { type: "base64", media_type: "image/gif", data: "CCCC" } },
    ]);
    expect(readUserMessageContent({ content })).toEqual({
      texts: ["old row"],
      images: ["data:image/gif;base64,CCCC"],
    });
  });

  it("still renders LEGACY url-sourced image blocks", () => {
    const content = JSON.stringify([
      { type: "image", source: { type: "url", url: "https://x/y.png" } },
    ]);
    expect(readUserMessageContent({ content }).images).toEqual(["https://x/y.png"]);
  });

  it("treats non-JSON content as a single text run", () => {
    expect(readUserMessageContent({ content: "just a prompt" })).toEqual({
      texts: ["just a prompt"],
      images: [],
    });
  });

  it("does not mistake a markdown link for a blocks array", () => {
    const content = "[see this](https://example.com) — thoughts?";
    expect(readUserMessageContent({ content }).texts).toEqual([content]);
  });

  it("renders nothing for an absent content and no parts", () => {
    expect(readUserMessageContent({})).toEqual({ texts: [], images: [] });
    expect(readUserMessageContent({ content: null, parts: [] })).toEqual({
      texts: [],
      images: [],
    });
  });
});
