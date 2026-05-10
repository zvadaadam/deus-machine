import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrowserEmptyState } from "./BrowserEmptyState";
import { match } from "ts-pattern";
import {
  isConnected,
  onConnectionChange,
  onEvent,
  sendCommand,
} from "@/platform/ws/query-protocol-client";
import type { CommandName } from "@shared/types/query-protocol";
import type { Bounds } from "../webview-manager";
import { deriveTitleFromUrl, isBlankUrl } from "../types";
import type { BrowserTabHandle, BrowserTabState, ConsoleLog, ElementSelectedEvent } from "../types";
import {
  INSPECT_MODE_SETUP,
  INSPECT_MODE_ENABLE,
  INSPECT_MODE_DISABLE,
  INSPECT_MODE_DRAIN_EVENTS,
  INSPECT_MODE_VERIFY,
  INSPECT_MODE_HIDE_OVERLAYS,
  INSPECT_MODE_SHOW_OVERLAYS,
  buildInspectModeClearSelection,
} from "../automation/inspect-mode";
import { VISUAL_EFFECTS_SETUP } from "../automation/visual-effects";
import { getErrorMessage } from "@shared/lib/errors";
import type {
  BrowserProxyConsoleEvent,
  BrowserProxyErrorEvent,
  BrowserProxyFrameEvent,
  BrowserProxyStateEvent,
} from "@shared/types/browser-proxy";
import {
  BROWSER_FRAME_MEDIA_TRANSPORT,
  useBrowserFrameMediaTransport,
} from "./browserFrameMediaTransport";
import { REMOTE_BROWSER_COMMAND_TIMEOUT_MS } from "./remoteBrowserConstants";
import { useRemoteBrowserInput } from "./useRemoteBrowserInput";
import { useRemoteBrowserPanelBounds } from "./useRemoteBrowserPanelBounds";

const INSPECT_DRAIN_INTERVAL_MS = 200;

async function sendBrowserCommand(
  command: CommandName,
  params: Record<string, unknown>,
  timeoutMs = REMOTE_BROWSER_COMMAND_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  const result = await sendCommand(command, params, timeoutMs);
  if (!result.accepted) {
    throw new Error(result.error || `${command} failed`);
  }
  return result;
}

interface RemoteBrowserTabProps {
  tab: BrowserTabState;
  workspaceId: string | null;
  onUpdateTab: (tabId: string, updates: Partial<BrowserTabState>) => void;
  onAddLog: (tabId: string, level: ConsoleLog["level"], message: string) => void;
  visible: boolean;
  onElementSelected?: (tabId: string, event: ElementSelectedEvent) => void;
}

function remoteBrowserErrorMessage(err: unknown): string {
  const message = getErrorMessage(err);
  if (
    /(?:agent-browser stream|CDP request failed|CDP_PORT|ECONNREFUSED|fetch failed|desktop app)/iu.test(
      message
    )
  ) {
    return "Launch the desktop app and keep this workspace connected to use the browser from web.";
  }
  return message;
}

export const RemoteBrowserTab = forwardRef<BrowserTabHandle, RemoteBrowserTabProps>(
  function RemoteBrowserTab(
    { tab, workspaceId, onUpdateTab, onAddLog, visible, onElementSelected },
    ref
  ) {
    const tabId = tab.id;
    const mediaTransport = useBrowserFrameMediaTransport();
    const [hasLoaded, setHasLoaded] = useState(false);
    const [completingLoad, setCompletingLoad] = useState(false);
    const [wsConnected, setWsConnected] = useState(isConnected());
    const completingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const attachedRef = useRef(false);
    const attachInFlightRef = useRef<Promise<void> | null>(null);
    const hasLoadedRef = useRef(false);
    const automationInjectedRef = useRef(false);
    const suppressHistoryPushRef = useRef(false);
    const historyNavDeltaRef = useRef<-1 | 0 | 1>(0);

    const tabRef = useRef(tab);
    tabRef.current = tab;
    const onElementSelectedRef =
      useRef<RemoteBrowserTabProps["onElementSelected"]>(onElementSelected);
    onElementSelectedRef.current = onElementSelected;

    const { panelContainerRef, panelRect, bounds } = useRemoteBrowserPanelBounds(tab.isMobileView);

    const pageBoundsRef = useRef<Bounds | null>(null);
    pageBoundsRef.current = bounds;
    const boundsWidth = bounds?.width;
    const boundsHeight = bounds?.height;

    const completeLoadTransition = useCallback(() => {
      if (hasLoadedRef.current) return;
      hasLoadedRef.current = true;
      setHasLoaded(true);
      setCompletingLoad(true);
      if (completingTimerRef.current) clearTimeout(completingTimerRef.current);
      completingTimerRef.current = setTimeout(() => setCompletingLoad(false), 500);
    }, []);

    const markPixelsVisible = useCallback(() => {
      completeLoadTransition();
      onUpdateTab(tabId, { loading: false, error: null });
    }, [completeLoadTransition, onUpdateTab, tabId]);

    const handleNavigated = useCallback(
      (url: string) => {
        if (isBlankUrl(url)) return;
        if (suppressHistoryPushRef.current) {
          suppressHistoryPushRef.current = false;
          const current = tabRef.current;
          const delta = historyNavDeltaRef.current;
          historyNavDeltaRef.current = 0;
          const nextIndex = Math.max(
            0,
            Math.min(current.history.length - 1, current.historyIndex + delta)
          );
          onUpdateTab(tabId, {
            url,
            currentUrl: url,
            title: deriveTitleFromUrl(url),
            historyIndex: nextIndex,
          });
          return;
        }
        const current = tabRef.current;
        if (current.currentUrl === url) {
          onUpdateTab(tabId, { title: deriveTitleFromUrl(url) });
          return;
        }
        const newHistory = current.history.slice(0, current.historyIndex + 1);
        newHistory.push(url);
        onUpdateTab(tabId, {
          url,
          currentUrl: url,
          title: deriveTitleFromUrl(url),
          history: newHistory,
          historyIndex: newHistory.length - 1,
        });
      },
      [onUpdateTab, tabId]
    );

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
          if (state.loading === false) {
            completeLoadTransition();
          }
          onUpdateTab(tabId, {
            ...(state.title ? { title: state.title } : {}),
            ...(state.loading !== undefined ? { loading: state.loading } : {}),
            ...(state.error !== undefined
              ? { error: state.error === null ? null : remoteBrowserErrorMessage(state.error) }
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
            const message = remoteBrowserErrorMessage(err.error);
            onAddLog(tabId, "error", message);
            onUpdateTab(tabId, { error: message, loading: false });
          }
        }
      });
    }, [
      completeLoadTransition,
      handleNavigated,
      markPixelsVisible,
      mediaTransport,
      onAddLog,
      onUpdateTab,
      tabId,
    ]);

    useEffect(() => {
      return () => {
        if (completingTimerRef.current) clearTimeout(completingTimerRef.current);
      };
    }, []);

    useEffect(() => {
      return onConnectionChange((connected) => {
        if (connected) {
          attachedRef.current = false;
          attachInFlightRef.current = null;
        }
        setWsConnected(connected);
      });
    }, []);

    const attachOrResize = useCallback(
      async (nextUrl = tabRef.current.currentUrl) => {
        if (!boundsWidth || !boundsHeight || isBlankUrl(nextUrl)) return;
        const params = {
          tabId,
          ...(workspaceId ? { workspaceId } : {}),
          url: nextUrl,
          width: boundsWidth,
          height: boundsHeight,
          isMobileView: tabRef.current.isMobileView,
          mediaTransport: BROWSER_FRAME_MEDIA_TRANSPORT,
        };
        if (!attachedRef.current) {
          if (!attachInFlightRef.current) {
            const attachPromise = sendBrowserCommand(
              "browser:attach",
              params,
              REMOTE_BROWSER_COMMAND_TIMEOUT_MS
            )
              .then(() => {
                attachedRef.current = true;
              })
              .finally(() => {
                if (attachInFlightRef.current === attachPromise) {
                  attachInFlightRef.current = null;
                }
              });
            attachInFlightRef.current = attachPromise;
          }
          return attachInFlightRef.current;
        }
        await sendBrowserCommand("browser:resize", params, REMOTE_BROWSER_COMMAND_TIMEOUT_MS);
      },
      [boundsHeight, boundsWidth, tabId, workspaceId]
    );

    useEffect(() => {
      if (!visible || !wsConnected) return;
      attachOrResize().catch((err) => {
        const message = remoteBrowserErrorMessage(err);
        onAddLog(tabId, "error", `Remote browser attach failed: ${message}`);
        onUpdateTab(tabId, { loading: false, error: message });
      });
    }, [
      visible,
      wsConnected,
      attachOrResize,
      tab.currentUrl,
      tab.isMobileView,
      bounds?.width,
      bounds?.height,
      onAddLog,
      onUpdateTab,
      tabId,
    ]);

    useEffect(() => {
      if (visible || !attachedRef.current) return;
      sendCommand("browser:detach", { tabId }, REMOTE_BROWSER_COMMAND_TIMEOUT_MS).catch(() => {});
      attachedRef.current = false;
      attachInFlightRef.current = null;
    }, [visible, tabId]);

    useEffect(() => {
      return () => {
        if (!attachedRef.current) return;
        sendCommand("browser:detach", { tabId }, REMOTE_BROWSER_COMMAND_TIMEOUT_MS).catch(() => {});
        attachedRef.current = false;
        attachInFlightRef.current = null;
      };
    }, [tabId]);

    const navigateToUrl = useCallback(
      (url: string) => {
        const run = async () => {
          if (!attachedRef.current) {
            await attachOrResize(url);
            return;
          }
          await sendBrowserCommand(
            "browser:navigate",
            { tabId, url },
            REMOTE_BROWSER_COMMAND_TIMEOUT_MS
          );
        };
        run().catch((err) => {
          const message = remoteBrowserErrorMessage(err);
          onAddLog(tabId, "error", `Navigation failed: ${message}`);
          onUpdateTab(tabId, { loading: false, error: message });
        });
      },
      [attachOrResize, onAddLog, onUpdateTab, tabId]
    );

    const goBack = useCallback(() => {
      suppressHistoryPushRef.current = true;
      historyNavDeltaRef.current = -1;
      sendBrowserCommand("browser:back", { tabId }, REMOTE_BROWSER_COMMAND_TIMEOUT_MS).catch(
        (err) => {
          onAddLog(tabId, "error", `Back failed: ${getErrorMessage(err)}`);
        }
      );
    }, [onAddLog, tabId]);

    const goForward = useCallback(() => {
      suppressHistoryPushRef.current = true;
      historyNavDeltaRef.current = 1;
      sendBrowserCommand("browser:forward", { tabId }, REMOTE_BROWSER_COMMAND_TIMEOUT_MS).catch(
        (err) => {
          onAddLog(tabId, "error", `Forward failed: ${getErrorMessage(err)}`);
        }
      );
    }, [onAddLog, tabId]);

    const reload = useCallback(() => {
      sendBrowserCommand("browser:reload", { tabId }, REMOTE_BROWSER_COMMAND_TIMEOUT_MS).catch(
        (err) => {
          onAddLog(tabId, "error", `Reload failed: ${getErrorMessage(err)}`);
        }
      );
    }, [onAddLog, tabId]);

    const evalBrowser = useCallback(
      async (expression: string): Promise<unknown> => {
        const result = await sendBrowserCommand(
          "browser:eval",
          { tabId, expression },
          REMOTE_BROWSER_COMMAND_TIMEOUT_MS
        );
        return result.result;
      },
      [tabId]
    );

    const injectAutomation = useCallback(async (): Promise<boolean> => {
      if (automationInjectedRef.current) return true;
      try {
        await evalBrowser(INSPECT_MODE_SETUP);
        await evalBrowser(VISUAL_EFFECTS_SETUP);
        const rawStatus = await evalBrowser(INSPECT_MODE_VERIFY);
        const status =
          typeof rawStatus === "string" ? (JSON.parse(rawStatus) as Record<string, boolean>) : null;
        if (!status || !status.deusInspect || !status.hasDrainEvents) {
          onAddLog(tabId, "error", `Inspect mode setup incomplete: ${JSON.stringify(status)}`);
          onUpdateTab(tabId, { injectionFailed: true });
          return false;
        }
        automationInjectedRef.current = true;
        onUpdateTab(tabId, { injected: true, injectionFailed: false });
        onAddLog(tabId, "info", "Automation scripts injected");
        return true;
      } catch (err) {
        onAddLog(tabId, "error", `Injection failed: ${getErrorMessage(err)}`);
        onUpdateTab(tabId, { injectionFailed: true });
        return false;
      }
    }, [evalBrowser, onAddLog, onUpdateTab, tabId]);

    useEffect(() => {
      if (!tab.loading) return;
      automationInjectedRef.current = false;
      onUpdateTab(tabId, { injected: false, selectorActive: false });
    }, [tab.loading, onUpdateTab, tabId]);

    useEffect(() => {
      if (!hasLoaded || tab.injected || tab.injectionFailed || isBlankUrl(tab.currentUrl)) return;
      requestAnimationFrame(() => {
        injectAutomation();
      });
    }, [hasLoaded, tab.injected, tab.injectionFailed, tab.currentUrl, injectAutomation]);

    const setElementSelectorActive = useCallback(
      async (active: boolean) => {
        if (active && !automationInjectedRef.current) {
          const ok = await injectAutomation();
          if (!ok) return;
        }
        if (tabRef.current.selectorActive === active) return;
        try {
          await evalBrowser(active ? INSPECT_MODE_ENABLE : INSPECT_MODE_DISABLE);
          onAddLog(tabId, "info", active ? "Inspect mode activated" : "Inspect mode deactivated");
          onUpdateTab(tabId, { selectorActive: active });
        } catch (err) {
          onAddLog(tabId, "error", `Inspect mode toggle failed: ${getErrorMessage(err)}`);
        }
      },
      [evalBrowser, injectAutomation, onAddLog, onUpdateTab, tabId]
    );

    const toggleElementSelector = useCallback(() => {
      setElementSelectorActive(!tabRef.current.selectorActive);
    }, [setElementSelectorActive]);

    useEffect(() => {
      if (!visible || !hasLoaded || !tab.selectorActive) return;

      evalBrowser(INSPECT_MODE_DRAIN_EVENTS).catch(() => {});
      let failCount = 0;
      let inFlight = false;

      const interval = setInterval(async () => {
        if (inFlight) return;
        inFlight = true;
        try {
          const result = await evalBrowser(INSPECT_MODE_DRAIN_EVENTS);
          failCount = 0;
          if (typeof result !== "string" || result === "[]") return;
          let events: Array<{ type: string; data: Record<string, unknown> }>;
          try {
            events = JSON.parse(result);
          } catch {
            return;
          }
          for (const evt of events) {
            match(evt.type)
              .with("element-event", () => {
                const parsed = evt.data as unknown as ElementSelectedEvent;
                onElementSelectedRef.current?.(tabId, parsed);
              })
              .with("selection-mode", () => {
                const modeData = evt.data as { active: boolean };
                onUpdateTab(tabId, { selectorActive: modeData.active });
              })
              .otherwise(() => {});
          }
        } catch (err) {
          failCount++;
          if (failCount <= 3 || failCount % 50 === 0) {
            onAddLog(
              tabId,
              "warn",
              `inspect drain failed (${failCount}x): ${getErrorMessage(err)}`
            );
          }
        } finally {
          inFlight = false;
        }
      }, INSPECT_DRAIN_INTERVAL_MS);

      return () => clearInterval(interval);
    }, [visible, hasLoaded, tab.selectorActive, evalBrowser, tabId, onUpdateTab, onAddLog]);

    const captureScreenshot = useCallback(
      async (rect?: {
        x: number;
        y: number;
        width: number;
        height: number;
      }): Promise<string | null> => {
        if (mediaTransport.canvasRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          const dataUrl = mediaTransport.captureScreenshot(rect);
          if (dataUrl) return dataUrl;
        }

        try {
          const result = await sendBrowserCommand(
            "browser:captureScreenshot",
            { tabId, ...(rect ? { rect } : {}) },
            REMOTE_BROWSER_COMMAND_TIMEOUT_MS
          );
          return typeof result.dataUrl === "string" ? result.dataUrl : null;
        } catch (err) {
          onAddLog(tabId, "error", `Screenshot failed: ${getErrorMessage(err)}`);
          return null;
        }
      },
      [mediaTransport, onAddLog, tabId]
    );

    const setInspectOverlaysVisible = useCallback(
      async (overlaysVisible: boolean): Promise<void> => {
        try {
          await evalBrowser(
            overlaysVisible ? INSPECT_MODE_SHOW_OVERLAYS : INSPECT_MODE_HIDE_OVERLAYS
          );
        } catch {
          // Best-effort: same behavior as the native webview path.
        }
      },
      [evalBrowser]
    );

    const clearInspectSelection = useCallback(
      async (expectedSelectionKey?: string): Promise<void> => {
        try {
          await evalBrowser(buildInspectModeClearSelection(expectedSelectionKey));
        } catch {
          // Best-effort: same behavior as the native webview path.
        }
      },
      [evalBrowser]
    );

    const getWebviewBounds = useCallback((): Bounds | null => pageBoundsRef.current, []);

    useImperativeHandle(
      ref,
      () => ({
        navigateToUrl,
        goBack,
        goForward,
        reload,
        injectAutomation,
        toggleElementSelector,
        setElementSelectorActive,
        captureScreenshot,
        setInspectOverlaysVisible,
        clearInspectSelection,
        getWebviewBounds,
      }),
      [
        navigateToUrl,
        goBack,
        goForward,
        reload,
        injectAutomation,
        toggleElementSelector,
        setElementSelectorActive,
        captureScreenshot,
        setInspectOverlaysVisible,
        clearInspectSelection,
        getWebviewBounds,
      ]
    );

    const canvasPointFromClient = useCallback(
      (clientX: number, clientY: number) => {
        return mediaTransport.pointFromClient(clientX, clientY);
      },
      [mediaTransport]
    );
    const { sendMouse, sendWheel, sendKey, sendTouch } = useRemoteBrowserInput(
      tabId,
      canvasPointFromClient
    );

    return (
      <div
        ref={panelContainerRef}
        className="relative h-full min-h-0 w-full min-w-0 overflow-hidden [grid-area:1/1]"
      >
        {visible && bounds && !isBlankUrl(tab.currentUrl) && (
          <canvas
            ref={mediaTransport.canvasRef}
            tabIndex={0}
            className="bg-bg h-full w-full outline-none"
            style={{
              width: `${bounds.width}px`,
              height: `${bounds.height}px`,
              marginLeft: `${Math.max(0, (panelRect?.width ?? bounds.width) - bounds.width) / 2}px`,
              touchAction: "none",
            }}
            onMouseDown={(e) => {
              e.currentTarget.focus();
              sendMouse("mousePressed", e);
            }}
            onMouseUp={(e) => sendMouse("mouseReleased", e)}
            onMouseMove={(e) => sendMouse("mouseMoved", e)}
            onWheel={sendWheel}
            onTouchStart={(e) => sendTouch("touchStart", e)}
            onTouchMove={(e) => sendTouch("touchMove", e)}
            onTouchEnd={(e) => sendTouch("touchEnd", e)}
            onTouchCancel={(e) => sendTouch("touchCancel", e)}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => sendKey("keyDown", e)}
            onKeyUp={(e) => sendKey("keyUp", e)}
          />
        )}

        {visible && (tab.loading || completingLoad) && (
          <div
            className="bg-primary pointer-events-none absolute inset-x-0 top-0 z-20 h-[2px] origin-left"
            style={{
              animation: tab.loading
                ? "browser-loading 8s cubic-bezier(.19,1,.22,1) forwards"
                : "browser-loading-complete 0.4s ease-out forwards",
            }}
          />
        )}

        {visible && isBlankUrl(tab.currentUrl) && !tab.loading && !tab.error && (
          <BrowserEmptyState
            onOpen={navigateToUrl}
            description="Streams from the browser on your connected computer"
          />
        )}

        {visible && tab.loading && !hasLoaded && (
          <div className="vibrancy-bg pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <Loader2 className="text-primary h-8 w-8 animate-spin" />
          </div>
        )}

        {visible && tab.error && (
          <div className="vibrancy-bg absolute inset-0 z-10 flex items-center justify-center">
            <div className="max-w-sm p-8 text-center">
              <div className="bg-destructive/10 mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl">
                <AlertCircle className="text-destructive h-5 w-5" />
              </div>
              <h3 className="mb-1 text-sm font-semibold">Unable to Load Page</h3>
              <p className="text-muted-foreground mb-4 text-xs">{tab.error}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onUpdateTab(tabId, { error: null });
                  if (tab.currentUrl) navigateToUrl(tab.currentUrl);
                }}
              >
                Try Again
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }
);
