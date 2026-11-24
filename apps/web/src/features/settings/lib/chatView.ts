import type { Settings } from "../types";

export type ChatView = NonNullable<Settings["chat_view"]>;

export const CHAT_VIEWS = [
  { value: "bubbles", label: "Chat bubbles" },
  { value: "full", label: "Full run" },
] as const satisfies readonly { value: ChatView; label: string }[];

export function chatView(settings?: Settings): ChatView {
  return settings?.chat_view === "full" ? "full" : "bubbles";
}
