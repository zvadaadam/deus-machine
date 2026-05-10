import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type * as React from "react";
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
import {
  deriveTitleFromUrl,
  isBlankUrl,
  FOCUS_URL_BAR_EVENT,
  MOBILE_PREVIEW_WIDTH,
} from "../types";
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
  BrowserProxyWebRtcDescriptionEvent,
  BrowserProxyWebRtcIceCandidateEvent,
  BrowserProxyWebRtcStopEvent,
} from "@shared/types/browser-proxy";
import {
  createBrowserRtcPeerConnection,
  isBrowserWebRtcExperimentEnabled,
  makeBrowserWebRtcPeerId,
  makeIceCommandParams,
} from "./browserWebRtcExperiment";

const INSPECT_DRAIN_INTERVAL_MS = 200;
const REMOTE_COMMAND_TIMEOUT_MS = 20_000;

type WebRtcViewerState = "idle" | "connecting" | "connected" | "failed";

async function sendBrowserCommand(
  command: CommandName,
  params: Record<string, unknown>,
  timeoutMs = REMOTE_COMMAND_TIMEOUT_MS
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

function modifierMask(
  e: Pick<
    KeyboardEvent | React.KeyboardEvent | React.MouseEvent | React.TouchEvent,
    "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
  >
): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

function keyText(e: React.KeyboardEvent): string | undefined {
  if (e.key.length !== 1) return undefined;
  if (e.metaKey || e.ctrlKey) return undefined;
  return e.key;
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

function mouseButton(button: number): "left" | "middle" | "right" | "none" {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "none";
}

function captureCanvasDataUrl(
  canvas: HTMLCanvasElement,
  rect?: { x: number; y: number; width: number; height: number }
): string | null {
  if (canvas.width <= 0 || canvas.height <= 0) return null;
  if (!rect) return canvas.toDataURL("image/png");

  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  if (x >= canvas.width || y >= canvas.height) return null;
  const width = Math.max(1, Math.min(canvas.width - x, Math.floor(rect.width)));
  const height = Math.max(1, Math.min(canvas.height - y, Math.floor(rect.height)));
  if (width <= 0 || height <= 0) return null;

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
  return out.toDataURL("image/png");
}

export const RemoteBrowserTab = forwardRef<BrowserTabHandle, RemoteBrowserTabProps>(
  function RemoteBrowserTab(
    { tab, workspaceId, onUpdateTab, onAddLog, visible, onElementSelected },
    ref
  ) {
    const tabId = tab.id;
    const panelContainerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [panelRect, setPanelRect] = useState<Bounds | null>(null);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [completingLoad, setCompletingLoad] = useState(false);
    const [wsConnected, setWsConnected] = useState(isConnected());
    const [webRtcState, setWebRtcState] = useState<WebRtcViewerState>("idle");
    const completingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const attachedRef = useRef(false);
    const hasLoadedRef = useRef(false);
    const lastMouseMoveAtRef = useRef(0);
    const frameSizeRef = useRef({ width: 1, height: 1 });
    const drawRequestRef = useRef(0);
    const automationInjectedRef = useRef(false);
    const suppressHistoryPushRef = useRef(false);
    const historyNavDeltaRef = useRef<-1 | 0 | 1>(0);
    const webRtcEnabled = isBrowserWebRtcExperimentEnabled();
    const webRtcPeerRef = useRef<{ peerId: string; pc: RTCPeerConnection } | null>(null);

    const tabRef = useRef(tab);
    tabRef.current = tab;
    const onElementSelectedRef =
      useRef<RemoteBrowserTabProps["onElementSelected"]>(onElementSelected);
    onElementSelectedRef.current = onElementSelected;

    useLayoutEffect(() => {
      const el = panelContainerRef.current;
      if (!el) return;
      const update = () => {
        const r = el.getBoundingClientRect();
        setPanelRect({ x: r.x, y: r.y, width: r.width, height: r.height });
      };
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      window.addEventListener("resize", update);
      window.addEventListener("scroll", update, true);
      return () => {
        ro.disconnect();
        window.removeEventListener("resize", update);
        window.removeEventListener("scroll", update, true);
      };
    }, []);

    const SPLITTER_GUARD = 6;
    const bounds: Bounds | null = (() => {
      if (!panelRect) return null;
      const available = Math.max(0, panelRect.width - SPLITTER_GUARD * 2);
      const w = tab.isMobileView ? Math.min(MOBILE_PREVIEW_WIDTH, available) : available;
      const x = panelRect.x + (panelRect.width - w) / 2;
      return { x, y: panelRect.y, width: w, height: panelRect.height };
    })();

    const pageBoundsRef = useRef<Bounds | null>(null);
    pageBoundsRef.current = bounds;
    const boundsWidth = bounds?.width;
    const boundsHeight = bounds?.height;

    const markPixelsVisible = useCallback(() => {
      if (hasLoadedRef.current) return;
      hasLoadedRef.current = true;
      setHasLoaded(true);
      setCompletingLoad(true);
      if (completingTimerRef.current) clearTimeout(completingTimerRef.current);
      completingTimerRef.current = setTimeout(() => setCompletingLoad(false), 500);
      onUpdateTab(tabId, { loading: false, error: null });
    }, [onUpdateTab, tabId]);

    const drawFrame = useCallback((frame: BrowserProxyFrameEvent, onDrawn?: () => void) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const drawRequest = ++drawRequestRef.current;
      frameSizeRef.current = { width: frame.width, height: frame.height };
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      const img = new Image();
      img.onload = () => {
        if (drawRequest !== drawRequestRef.current) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, frame.width, frame.height);
        onDrawn?.();
      };
      img.src = `data:image/${frame.format};base64,${frame.data}`;
    }, []);

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

    const stopWebRtcViewer = useCallback(
      (notifyPublisher: boolean) => {
        const peer = webRtcPeerRef.current;
        if (!peer) {
          setWebRtcState("idle");
          return;
        }
        webRtcPeerRef.current = null;
        if (notifyPublisher) {
          sendCommand(
            "browser:webrtcStop",
            { tabId, peerId: peer.peerId, from: "viewer" },
            REMOTE_COMMAND_TIMEOUT_MS
          ).catch(() => {});
        }
        peer.pc.close();
        const video = videoRef.current;
        if (video?.srcObject instanceof MediaStream) {
          video.srcObject.getTracks().forEach((track) => track.stop());
          video.srcObject = null;
        }
        setWebRtcState("idle");
      },
      [tabId]
    );

    const startWebRtcViewer = useCallback(async () => {
      if (!webRtcEnabled || !workspaceId) return;
      if (webRtcPeerRef.current) return;
      if (typeof RTCPeerConnection === "undefined") {
        throw new Error("This browser does not support RTCPeerConnection");
      }

      const peerId = makeBrowserWebRtcPeerId(tabId);
      const pc = createBrowserRtcPeerConnection();
      webRtcPeerRef.current = { peerId, pc };
      setWebRtcState("connecting");

      pc.addTransceiver("video", { direction: "recvonly" });
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        const video = videoRef.current;
        if (!stream || !video) return;
        video.srcObject = stream;
        void video.play().catch(() => {});
        setWebRtcState("connected");
        markPixelsVisible();
      };
      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        sendCommand(
          "browser:webrtcIce",
          makeIceCommandParams(tabId, peerId, "viewer", event.candidate),
          REMOTE_COMMAND_TIMEOUT_MS
        ).catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setWebRtcState("connected");
          return;
        }
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          setWebRtcState("failed");
        }
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (!offer.sdp) throw new Error("WebRTC offer did not include SDP");
        await sendBrowserCommand(
          "browser:webrtcOffer",
          {
            tabId,
            peerId,
            workspaceId,
            type: "offer",
            sdp: offer.sdp,
          },
          REMOTE_COMMAND_TIMEOUT_MS
        );
      } catch (err) {
        if (webRtcPeerRef.current?.peerId === peerId) {
          webRtcPeerRef.current = null;
          pc.close();
          setWebRtcState("failed");
        }
        throw err;
      }
    }, [markPixelsVisible, tabId, webRtcEnabled, workspaceId]);

    useEffect(() => {
      return onEvent((event, data) => {
        if (event === "browser:frame") {
          if (webRtcState === "connected") return;
          const frame = data as BrowserProxyFrameEvent;
          if (frame.tabId === tabId) drawFrame(frame, markPixelsVisible);
          return;
        }

        if (event === "browser:state") {
          const state = data as BrowserProxyStateEvent;
          if (state.tabId !== tabId) return;
          if (state.currentUrl) handleNavigated(state.currentUrl);
          if (state.loading === false) {
            hasLoadedRef.current = true;
            setHasLoaded(true);
            setCompletingLoad(true);
            if (completingTimerRef.current) clearTimeout(completingTimerRef.current);
            completingTimerRef.current = setTimeout(() => setCompletingLoad(false), 500);
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
          return;
        }

        if (event === "browser:webrtcAnswer") {
          const answer = data as BrowserProxyWebRtcDescriptionEvent;
          const peer = webRtcPeerRef.current;
          if (!peer || answer.tabId !== tabId || answer.peerId !== peer.peerId) return;
          peer.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp }).catch((err) => {
            setWebRtcState("failed");
            onAddLog(tabId, "error", `WebRTC answer failed: ${getErrorMessage(err)}`);
          });
          return;
        }

        if (event === "browser:webrtcIce") {
          const ice = data as BrowserProxyWebRtcIceCandidateEvent;
          const peer = webRtcPeerRef.current;
          if (
            !peer ||
            ice.tabId !== tabId ||
            ice.peerId !== peer.peerId ||
            ice.from !== "publisher"
          ) {
            return;
          }
          peer.pc.addIceCandidate(ice.candidate).catch((err) => {
            onAddLog(tabId, "warn", `WebRTC ICE add failed: ${getErrorMessage(err)}`);
          });
          return;
        }

        if (event === "browser:webrtcStop") {
          const stop = data as BrowserProxyWebRtcStopEvent;
          const peer = webRtcPeerRef.current;
          if (
            !peer ||
            stop.tabId !== tabId ||
            stop.peerId !== peer.peerId ||
            stop.from !== "publisher"
          ) {
            return;
          }
          stopWebRtcViewer(false);
        }
      });
    }, [
      drawFrame,
      handleNavigated,
      markPixelsVisible,
      onAddLog,
      onUpdateTab,
      stopWebRtcViewer,
      tabId,
      webRtcState,
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
        } else {
          stopWebRtcViewer(false);
        }
        setWsConnected(connected);
      });
    }, [stopWebRtcViewer]);

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
          preferredTransport: webRtcEnabled ? "webrtc" : "frames",
        };
        if (!attachedRef.current) {
          await sendBrowserCommand("browser:attach", params, REMOTE_COMMAND_TIMEOUT_MS);
          attachedRef.current = true;
          await startWebRtcViewer();
          return;
        }
        await sendBrowserCommand("browser:resize", params, REMOTE_COMMAND_TIMEOUT_MS);
        await startWebRtcViewer();
      },
      [boundsHeight, boundsWidth, startWebRtcViewer, tabId, webRtcEnabled, workspaceId]
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
      stopWebRtcViewer(true);
      sendCommand("browser:detach", { tabId }, REMOTE_COMMAND_TIMEOUT_MS).catch(() => {});
      attachedRef.current = false;
    }, [stopWebRtcViewer, visible, tabId]);

    useEffect(() => {
      return () => {
        stopWebRtcViewer(true);
        if (!attachedRef.current) return;
        sendCommand("browser:detach", { tabId }, REMOTE_COMMAND_TIMEOUT_MS).catch(() => {});
        attachedRef.current = false;
      };
    }, [stopWebRtcViewer, tabId]);

    const navigateToUrl = useCallback(
      (url: string) => {
        const run = async () => {
          if (!attachedRef.current) {
            await attachOrResize(url);
            return;
          }
          await sendBrowserCommand("browser:navigate", { tabId, url }, REMOTE_COMMAND_TIMEOUT_MS);
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
      sendBrowserCommand("browser:back", { tabId }, REMOTE_COMMAND_TIMEOUT_MS).catch((err) => {
        onAddLog(tabId, "error", `Back failed: ${getErrorMessage(err)}`);
      });
    }, [onAddLog, tabId]);

    const goForward = useCallback(() => {
      suppressHistoryPushRef.current = true;
      historyNavDeltaRef.current = 1;
      sendBrowserCommand("browser:forward", { tabId }, REMOTE_COMMAND_TIMEOUT_MS).catch((err) => {
        onAddLog(tabId, "error", `Forward failed: ${getErrorMessage(err)}`);
      });
    }, [onAddLog, tabId]);

    const reload = useCallback(() => {
      sendBrowserCommand("browser:reload", { tabId }, REMOTE_COMMAND_TIMEOUT_MS).catch((err) => {
        onAddLog(tabId, "error", `Reload failed: ${getErrorMessage(err)}`);
      });
    }, [onAddLog, tabId]);

    const evalBrowser = useCallback(
      async (expression: string): Promise<unknown> => {
        const result = await sendBrowserCommand(
          "browser:eval",
          { tabId, expression },
          REMOTE_COMMAND_TIMEOUT_MS
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
        const video = videoRef.current;
        if (webRtcEnabled && video && video.videoWidth > 0 && video.videoHeight > 0) {
          const out = document.createElement("canvas");
          out.width = Math.max(1, Math.floor(rect?.width ?? video.videoWidth));
          out.height = Math.max(1, Math.floor(rect?.height ?? video.videoHeight));
          const ctx = out.getContext("2d");
          if (ctx) {
            const sx = Math.max(0, Math.floor(rect?.x ?? 0));
            const sy = Math.max(0, Math.floor(rect?.y ?? 0));
            const sw = Math.max(
              1,
              Math.min(video.videoWidth - sx, Math.floor(rect?.width ?? video.videoWidth))
            );
            const sh = Math.max(
              1,
              Math.min(video.videoHeight - sy, Math.floor(rect?.height ?? video.videoHeight))
            );
            ctx.drawImage(video, sx, sy, sw, sh, 0, 0, out.width, out.height);
            return out.toDataURL("image/png");
          }
        }

        const canvas = canvasRef.current;
        if (canvas) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          const dataUrl = captureCanvasDataUrl(canvas, rect);
          if (dataUrl) return dataUrl;
        }

        try {
          const result = await sendBrowserCommand(
            "browser:captureScreenshot",
            { tabId, ...(rect ? { rect } : {}) },
            REMOTE_COMMAND_TIMEOUT_MS
          );
          return typeof result.dataUrl === "string" ? result.dataUrl : null;
        } catch (err) {
          onAddLog(tabId, "error", `Screenshot failed: ${getErrorMessage(err)}`);
          return null;
        }
      },
      [onAddLog, tabId, webRtcEnabled]
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
        const surface =
          webRtcState === "connected" && videoRef.current ? videoRef.current : canvasRef.current;
        if (!surface) return { x: 0, y: 0 };
        const rect = surface.getBoundingClientRect();
        const video = surface instanceof HTMLVideoElement ? surface : null;
        const frame =
          video?.videoWidth && video.videoHeight
            ? { width: video.videoWidth, height: video.videoHeight }
            : frameSizeRef.current;
        return {
          x: ((clientX - rect.left) / Math.max(1, rect.width)) * frame.width,
          y: ((clientY - rect.top) / Math.max(1, rect.height)) * frame.height,
        };
      },
      [webRtcState]
    );

    const canvasPoint = useCallback(
      (e: React.MouseEvent<HTMLElement>) => canvasPointFromClient(e.clientX, e.clientY),
      [canvasPointFromClient]
    );

    const sendMouse = useCallback(
      (
        inputType: "mousePressed" | "mouseReleased" | "mouseMoved",
        e: React.MouseEvent<HTMLElement>
      ) => {
        if (inputType === "mouseMoved") {
          const now = Date.now();
          if (now - lastMouseMoveAtRef.current < 33) return;
          lastMouseMoveAtRef.current = now;
        }
        const point = canvasPoint(e);
        sendCommand(
          "browser:input",
          {
            tabId,
            kind: "mouse",
            inputType,
            x: point.x,
            y: point.y,
            button: inputType === "mouseMoved" ? "none" : mouseButton(e.button),
            clickCount: inputType === "mouseMoved" ? 0 : 1,
            modifiers: modifierMask(e),
          },
          REMOTE_COMMAND_TIMEOUT_MS
        ).catch(() => {});
      },
      [canvasPoint, tabId]
    );

    const sendWheel = useCallback(
      (e: React.WheelEvent<HTMLElement>) => {
        e.preventDefault();
        const point = canvasPoint(e);
        sendCommand(
          "browser:input",
          {
            tabId,
            kind: "wheel",
            x: point.x,
            y: point.y,
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            modifiers: modifierMask(e),
          },
          REMOTE_COMMAND_TIMEOUT_MS
        ).catch(() => {});
      },
      [canvasPoint, tabId]
    );

    const sendKey = useCallback(
      (inputType: "keyDown" | "keyUp", e: React.KeyboardEvent<HTMLElement>) => {
        const isFocusUrl =
          inputType === "keyDown" && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l";
        if (isFocusUrl) {
          window.dispatchEvent(new CustomEvent(FOCUS_URL_BAR_EVENT));
          e.preventDefault();
          return;
        }
        e.preventDefault();
        sendCommand(
          "browser:input",
          {
            tabId,
            kind: "key",
            inputType,
            key: e.key,
            code: e.code,
            text: keyText(e),
            modifiers: modifierMask(e),
          },
          REMOTE_COMMAND_TIMEOUT_MS
        ).catch(() => {});
      },
      [tabId]
    );

    const sendTouch = useCallback(
      (
        inputType: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
        e: React.TouchEvent<HTMLElement>
      ) => {
        e.preventDefault();
        const sourceTouches =
          inputType === "touchEnd" || inputType === "touchCancel" ? [] : Array.from(e.touches);
        sendCommand(
          "browser:input",
          {
            tabId,
            kind: "touch",
            inputType,
            touchPoints: sourceTouches.map((touch) => ({
              id: touch.identifier,
              ...canvasPointFromClient(touch.clientX, touch.clientY),
            })),
            modifiers: modifierMask(e),
          },
          REMOTE_COMMAND_TIMEOUT_MS
        ).catch(() => {});
      },
      [canvasPointFromClient, tabId]
    );

    return (
      <div
        ref={panelContainerRef}
        className="relative h-full min-h-0 w-full min-w-0 overflow-hidden [grid-area:1/1]"
      >
        {visible && bounds && !isBlankUrl(tab.currentUrl) && webRtcEnabled && (
          <video
            ref={videoRef}
            tabIndex={0}
            autoPlay
            playsInline
            muted
            className="bg-bg h-full w-full outline-none"
            style={{
              width: `${bounds.width}px`,
              height: `${bounds.height}px`,
              marginLeft: `${Math.max(0, (panelRect?.width ?? bounds.width) - bounds.width) / 2}px`,
              touchAction: "none",
            }}
            onLoadedMetadata={(e) => {
              frameSizeRef.current = {
                width: e.currentTarget.videoWidth || bounds.width,
                height: e.currentTarget.videoHeight || bounds.height,
              };
              markPixelsVisible();
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

        {visible && bounds && !isBlankUrl(tab.currentUrl) && !webRtcEnabled && (
          <canvas
            ref={canvasRef}
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

        {visible && webRtcEnabled && webRtcState !== "connected" && !tab.error && (
          <div className="bg-bg/80 text-muted-foreground pointer-events-none absolute top-3 right-3 z-20 rounded-md px-2 py-1 text-[11px] shadow-sm backdrop-blur">
            WebRTC {webRtcState === "failed" ? "failed" : "connecting"}
          </div>
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
