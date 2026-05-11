import { useEffect } from "react";
import { onEvent } from "@/platform/ws/query-protocol-client";
import type { BrowserTabState, ConsoleLog } from "../types";
import type {
  BrowserProxyConsoleEvent,
  BrowserProxyErrorEvent,
  BrowserProxyFrameEvent,
  BrowserProxyStateEvent,
} from "@shared/types/browser-proxy";
import type { BrowserFrameMediaTransport } from "./browserFrameMediaTransport";

interface UseRemoteBrowserEventsArgs {
  tabId: string;
  mediaTransport: BrowserFrameMediaTransport;
  markPixelsVisible: () => void;
  completeLoadTransition: () => void;
  handleNavigated: (url: string) => void;
  onAddLog: (tabId: string, level: ConsoleLog["level"], message: string) => void;
  onUpdateTab: (tabId: string, updates: Partial<BrowserTabState>) => void;
  formatError: (err: unknown) => string;
}

export function useRemoteBrowserEvents({
  tabId,
  mediaTransport,
  markPixelsVisible,
  completeLoadTransition,
  handleNavigated,
  onAddLog,
  onUpdateTab,
  formatError,
}: UseRemoteBrowserEventsArgs): void {
  useEffect(() => {
    return onEvent((event, data) => {
      if (event === "browser:frame") {
        const frame = data as BrowserProxyFrameEvent;
        if (frame.tabId === tabId) mediaTransport.drawFrame(frame, markPixelsVisible);
        return;
      }

      if (event === "browser:state") {
        const state = data as BrowserProxyStateEvent;
        if (state.tabId !== tabId) return;
        if (state.currentUrl) handleNavigated(state.currentUrl);
        if (state.loading === false) completeLoadTransition();
        onUpdateTab(tabId, {
          ...(state.title ? { title: state.title } : {}),
          ...(state.loading !== undefined ? { loading: state.loading } : {}),
          ...(state.error !== undefined
            ? { error: state.error === null ? null : formatError(state.error) }
            : {}),
        });
        return;
      }

      if (event === "browser:console") {
        const log = data as BrowserProxyConsoleEvent;
        if (log.tabId === tabId) onAddLog(tabId, log.level, log.message);
        return;
      }

      if (event === "browser:error") {
        const err = data as BrowserProxyErrorEvent;
        if (err.tabId === tabId) {
          const message = formatError(err.error);
          onAddLog(tabId, "error", message);
          onUpdateTab(tabId, { error: message, loading: false });
        }
      }
    });
  }, [
    completeLoadTransition,
    formatError,
    handleNavigated,
    markPixelsVisible,
    mediaTransport,
    onAddLog,
    onUpdateTab,
    tabId,
  ]);
}
