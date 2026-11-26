import { StrictMode, createElement, useRef, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAutoScroll } from "@/features/session/hooks/useAutoScroll";
import { Chat } from "@/features/session/ui/Chat";
import { SessionProvider } from "@/features/session/context";
import "@/global.css";

const root = createRoot(document.getElementById("root")!);
const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
const sessionId = "scroll-fixture";
const subagentMessages = new Map();

function ScrollPane({
  height,
  count,
  loading,
}: {
  height: number;
  count: number;
  loading: boolean;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const { showScrollButton, transcriptRef, liveTailRef } = useAutoScroll({
    running: true,
    contentCount: count,
    lastContentId: "same-tail",
    messagesContainerRef: pane,
    userSendCount: 0,
  });
  return createElement(
    "div",
    {
      id: "pane",
      ref: pane,
      "data-paused": showScrollButton,
      style: { height: 300, overflowY: "auto", overflowAnchor: "none" },
    },
    loading
      ? createElement("div", { style: { height: 60 } })
      : createElement(
          "div",
          { ref: transcriptRef },
          createElement("div", { id: "tail", ref: liveTailRef, style: { height } })
        )
  );
}

Object.assign(window, {
  renderPane(key: string, props: ComponentProps<typeof ScrollPane>) {
    flushSync(() =>
      root.render(createElement(StrictMode, null, createElement(ScrollPane, { key, ...props })))
    );
  },
  renderChat(key: string, height: number, props: Partial<ComponentProps<typeof Chat>>) {
    const sessionStatus = props.sessionStatus ?? "idle";
    const chat = createElement(Chat, {
      key,
      sessionId,
      sessionStatus,
      messages: [],
      agentMessages: true,
      loading: false,
      ...props,
    });
    const session = createElement(SessionProvider, {
      sessionId,
      sessionStatus,
      subagentMessages,
      children: chat,
    });
    const providers = createElement(QueryClientProvider, {
      client,
      children: createElement(TooltipProvider, { children: session }),
    });
    const layout = createElement(
      "div",
      { style: { height, width: 740, maxWidth: "100%", display: "flex", position: "relative" } },
      providers
    );
    flushSync(() => root.render(createElement(StrictMode, null, layout)));
  },
});
