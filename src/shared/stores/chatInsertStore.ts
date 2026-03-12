/**
 * Chat Insert Store — typed Zustand store for dispatching content into the
 * active chat input. Replaces the untyped CustomEvent("insert-to-chat")
 * window event bus.
 *
 * Producers call chatInsertActions.insertText / insertFiles / insertElement
 * from any component (BrowserPanel, DiffViewer, SimulatorPanel).
 *
 * The single consumer (MainLayout) subscribes to pending payloads and
 * forwards them to the SessionPanel ref.
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { InspectElement } from "@/features/session/lib/parseInspectTags";

/**
 * Typed payloads for inserting content into the chat input.
 *
 * - text:    plain markdown (e.g., DiffViewer comment → chat)
 * - files:   File objects (e.g., browser screenshot, simulator screenshot)
 * - element: inspected DOM element metadata (e.g., BrowserPanel InSpec mode)
 */
export type ChatInsertPayload =
  | { type: "text"; workspaceId: string; text: string }
  | { type: "files"; workspaceId: string; files: File[] }
  | { type: "element"; workspaceId: string; element: InspectElement };

// SerializedChatInsertPayload is the Zod-inferred type from the event catalog.
// The Zod schema validates the transport shape; the inferred type aligns with
// InspectElement so no casting is needed at the boundary.
import type { SerializedChatInsertPayload } from "@shared/events";
export type { SerializedChatInsertPayload };

export interface ChatInsertTarget {
  insertText: (text: string) => void;
  addFiles: (files: File[]) => void;
  addInspectedElement: (element: InspectElement) => void;
}

interface ChatInsertState {
  pending: ChatInsertPayload | null;
  dispatch: (payload: ChatInsertPayload) => void;
  consume: () => void;
}

export const useChatInsertStore = create<ChatInsertState>()(
  devtools(
    (set) => ({
      pending: null,
      dispatch: (payload) => set({ pending: payload }, false, "chatInsert/dispatch"),
      consume: () => set({ pending: null }, false, "chatInsert/consume"),
    }),
    { name: "chat-insert-store", enabled: import.meta.env.DEV }
  )
);

/** Stable actions for use outside React components */
export const chatInsertActions = {
  dispatch: (payload: ChatInsertPayload) => useChatInsertStore.getState().dispatch(payload),
  insertText: (workspaceId: string, text: string) =>
    useChatInsertStore.getState().dispatch({ type: "text", workspaceId, text }),
  insertFiles: (workspaceId: string, files: File[]) =>
    useChatInsertStore.getState().dispatch({ type: "files", workspaceId, files }),
  insertElement: (workspaceId: string, element: InspectElement) =>
    useChatInsertStore.getState().dispatch({ type: "element", workspaceId, element }),
  consume: () => useChatInsertStore.getState().consume(),
};

export function isChatInsertForWorkspace(
  payload: ChatInsertPayload,
  activeWorkspaceId: string | null | undefined
): boolean {
  return !!activeWorkspaceId && payload.workspaceId === activeWorkspaceId;
}

export function deliverChatInsertPayload(
  target: ChatInsertTarget,
  payload: ChatInsertPayload
): void {
  switch (payload.type) {
    case "text":
      target.insertText(payload.text);
      return;
    case "files":
      target.addFiles(payload.files);
      return;
    case "element":
      target.addInspectedElement(payload.element);
      return;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(base64, "base64"));
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function serializeChatInsertPayload(
  payload: ChatInsertPayload
): Promise<SerializedChatInsertPayload> {
  switch (payload.type) {
    case "text":
      return payload;
    case "element":
      return payload;
    case "files":
      return {
        type: "files",
        workspaceId: payload.workspaceId,
        files: await Promise.all(
          payload.files.map(async (file) => ({
            name: file.name,
            type: file.type,
            lastModified: file.lastModified,
            base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
          }))
        ),
      };
  }
}

export async function deserializeChatInsertPayload(
  payload: SerializedChatInsertPayload
): Promise<ChatInsertPayload> {
  switch (payload.type) {
    case "text":
      return payload;
    case "element":
      return payload;
    case "files":
      return {
        type: "files",
        workspaceId: payload.workspaceId,
        files: payload.files.map((file) => {
          const bytes = Uint8Array.from(base64ToBytes(file.base64));
          return new File([bytes], file.name, {
            type: file.type,
            lastModified: file.lastModified,
          });
        }),
      };
  }
}
