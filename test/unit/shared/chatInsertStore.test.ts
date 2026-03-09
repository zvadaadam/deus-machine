import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectElement } from "@/features/session/lib/parseInspectTags";
import {
  chatInsertActions,
  deliverChatInsertPayload,
  deserializeChatInsertPayload,
  isChatInsertForWorkspace,
  serializeChatInsertPayload,
  useChatInsertStore,
} from "@/shared/stores/chatInsertStore";

const ELEMENT: InspectElement = {
  ref: "ref-save",
  tagName: "button",
  path: "body > button",
  innerText: "Save",
  context: "local",
  reactComponent: "SaveButton",
};

describe("chatInsertStore", () => {
  beforeEach(() => {
    chatInsertActions.consume();
  });

  it("stores typed pending payloads via stable actions", () => {
    chatInsertActions.insertText("ws-1", "Add this diff to chat");
    expect(useChatInsertStore.getState().pending).toEqual({
      type: "text",
      workspaceId: "ws-1",
      text: "Add this diff to chat",
    });

    chatInsertActions.insertElement("ws-1", ELEMENT);
    expect(useChatInsertStore.getState().pending).toEqual({
      type: "element",
      workspaceId: "ws-1",
      element: ELEMENT,
    });

    chatInsertActions.consume();
    expect(useChatInsertStore.getState().pending).toBeNull();
  });

  it("matches payloads to the active workspace", () => {
    const payload = { type: "text", workspaceId: "ws-1", text: "Hello" } as const;

    expect(isChatInsertForWorkspace(payload, "ws-1")).toBe(true);
    expect(isChatInsertForWorkspace(payload, "ws-2")).toBe(false);
    expect(isChatInsertForWorkspace(payload, null)).toBe(false);
  });

  it("delivers each payload type to the right chat panel method", () => {
    const file = new File(["image-bytes"], "shot.png", { type: "image/png" });
    const target = {
      insertText: vi.fn(),
      addFiles: vi.fn(),
      addInspectedElement: vi.fn(),
    };

    deliverChatInsertPayload(target, { type: "text", workspaceId: "ws-1", text: "Notes" });
    deliverChatInsertPayload(target, { type: "files", workspaceId: "ws-1", files: [file] });
    deliverChatInsertPayload(target, { type: "element", workspaceId: "ws-1", element: ELEMENT });

    expect(target.insertText).toHaveBeenCalledWith("Notes");
    expect(target.addFiles).toHaveBeenCalledWith([file]);
    expect(target.addInspectedElement).toHaveBeenCalledWith(ELEMENT);
  });

  it("round-trips file payloads for the detached-window bridge", async () => {
    const originalFile = new File(["pixel-data"], "browser-screenshot.jpg", {
      type: "image/jpeg",
      lastModified: 123,
    });

    const serialized = await serializeChatInsertPayload({
      type: "files",
      workspaceId: "ws-bridge",
      files: [originalFile],
    });

    expect(serialized).toMatchObject({
      type: "files",
      workspaceId: "ws-bridge",
      files: [
        {
          name: "browser-screenshot.jpg",
          type: "image/jpeg",
          lastModified: 123,
        },
      ],
    });

    const deserialized = await deserializeChatInsertPayload(serialized);
    expect(deserialized.type).toBe("files");
    expect(deserialized.workspaceId).toBe("ws-bridge");
    expect(deserialized.files).toHaveLength(1);
    await expect(deserialized.files[0].text()).resolves.toBe("pixel-data");
  });
});
