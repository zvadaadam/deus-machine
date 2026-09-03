/**
 * CloudSimulatorPanel — the Simulator tab on a cloud computer.
 *
 * A local workspace streams a Mac-hosted simulator over MJPEG; a cloud
 * computer's device lives in the platform, which hands us a stream URL to
 * embed. Nothing about it is persisted here: the store is seeded once from the
 * backend's `cloudSimulator` read (its in-memory latest, else the platform's
 * REST answer) and the `cloud:simulator` events keep it live — status,
 * screenshots and the agent's device actions.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, Play, RotateCcw, Sparkles, X } from "lucide-react";
import { match } from "ts-pattern";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { getErrorMessage } from "@shared/lib/errors";
import type { Workspace } from "@/shared/types";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";
import { processImageFiles } from "@/features/session/lib/imageAttachments";
import { DeviceFrame } from "../ui/DeviceFrame";
import { cloudSimulatorService } from "./cloudSimulator.service";
import {
  EMPTY_CLOUD_SIM_DEVICE,
  cloudSimulatorActions,
  ensureCloudSimulatorSubscription,
  useCloudSimulatorStore,
  type CloudSimActionResult,
} from "./cloudSimulatorStore";
import { describeCloudSimulatorError } from "./cloudSimulatorError";
import { CloudSimulatorHeader } from "./CloudSimulatorHeader";
import { cloudSimPhase, type CloudSimPhase } from "./cloudSimulatorPhase";
import { CloudSimulatorScreen } from "./CloudSimulatorScreen";

interface CloudSimulatorPanelProps {
  workspace: Workspace;
  visible: boolean;
}

/** The platform stops an idle device after 20 minutes; a viewer looking at
 *  it counts as activity only if it says so. Four minutes is comfortably
 *  inside that window and far too slow to be polling. */
const KEEP_ALIVE_MS = 4 * 60 * 1000;

/** How long an unanswered Start/Stop keeps its spinner. The backend
 *  synthesizes an error status when the sidecar can't be reached, so this is
 *  a self-heal for a command that got neither an echo nor an error. */
const BUSY_STALE_MS = 60 * 1000;

/** A screenshot request outlives its click for at most the exec round-trip:
 *  past this, a capture that lands is someone else's (the agent's) and must
 *  not attach to a forgotten button press. */
const SCREENSHOT_DEADLINE_MS = 65 * 1000;

interface ScreenshotRequest {
  askedAt: number;
  /** The chat active when the button was pressed — the attachment's target,
   *  whatever chat is active when the capture lands. */
  sessionId: string | null;
}

/** What the idle chip appends to the composer draft. */
const BUILD_AND_RUN_PROMPT = "Build and run the app on the cloud simulator";

/** The strip shows the tail of the store's ring. */
const VISIBLE_ACTIONS = 5;

function activeChatSessionId(workspaceId: string): string | null {
  return workspaceLayoutActions.getLayout(workspaceId).activeChatTabSessionId;
}

/** A platform screenshot (base64 PNG) → a composer image attachment, the
 *  same path the local panel's screenshot button takes. */
async function attachScreenshot(sessionId: string, base64: string): Promise<void> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const file = new File([bytes], `cloud-simulator-${Date.now()}.png`, { type: "image/png" });
  const processed = await processImageFiles([file]);
  if (processed.length) sessionComposerActions.addImageAttachments(sessionId, processed);
}

export function CloudSimulatorPanel({ workspace, visible }: CloudSimulatorPanelProps) {
  const workspaceId = workspace.id;
  const device = useCloudSimulatorStore(
    (s) => s.byWorkspace[workspaceId] ?? EMPTY_CLOUD_SIM_DEVICE
  );
  const phase = cloudSimPhase(device);

  // A command the wire refused (socket down, no cloud session): the platform
  // never answers those, so they live here rather than in the store's
  // platform-owned `error`. Cleared by the next action.
  const [sendError, setSendError] = useState<string | null>(null);

  // Subscribe before the first paint so no event that lands during mount is
  // missed; then seed ONCE for a workspace nothing was seen for yet (a live
  // event that arrives first wins — the seed is a fallback).
  useLayoutEffect(() => {
    ensureCloudSimulatorSubscription();
  }, []);
  const unknown = device.status === null;
  useEffect(() => {
    if (!unknown) return;
    let cancelled = false;
    cloudSimulatorService
      .status(workspaceId)
      .then((seed) => {
        if (!cancelled) cloudSimulatorActions.seedIfUnknown(workspaceId, seed);
      })
      .catch(() => {
        // Unreachable backend: the empty "Start device" state is honest enough.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, unknown]);

  useEffect(() => {
    if (!device.busy) return;
    const timer = setTimeout(() => cloudSimulatorActions.setBusy(workspaceId, null), BUSY_STALE_MS);
    return () => clearTimeout(timer);
  }, [device.busy, workspaceId]);

  // Keep-alive only while someone is actually looking at a live device; a
  // hidden tab or a booting device must not hold the platform's clock.
  useEffect(() => {
    if (!visible || device.status !== "ready") return;
    // Looking starts NOW: a device that has already idled through most of the
    // platform's window must hear it before the first interval tick.
    cloudSimulatorService.keepAlive(workspaceId).catch(() => {});
    const timer = setInterval(() => {
      cloudSimulatorService.keepAlive(workspaceId).catch(() => {});
    }, KEEP_ALIVE_MS);
    return () => clearInterval(timer);
  }, [visible, device.status, workspaceId]);

  const handleStart = useCallback(() => {
    setSendError(null);
    cloudSimulatorActions.setBusy(workspaceId, "starting");
    // Restart what was running before; a never-known platform lets the
    // environment's default decide.
    cloudSimulatorService.start(workspaceId, device.platform ?? undefined).catch((e) => {
      cloudSimulatorActions.setBusy(workspaceId, null);
      setSendError(getErrorMessage(e));
    });
  }, [workspaceId, device.platform]);

  const handleStop = useCallback(() => {
    setSendError(null);
    cloudSimulatorActions.setBusy(workspaceId, "stopping");
    cloudSimulatorService.stop(workspaceId).catch((e) => {
      cloudSimulatorActions.setBusy(workspaceId, null);
      setSendError(getErrorMessage(e));
    });
  }, [workspaceId]);

  const handleHome = useCallback(() => {
    setSendError(null);
    cloudSimulatorService
      .exec(workspaceId, "home")
      .then((res) => {
        if (!res.success) setSendError(res.error || "Home failed");
      })
      .catch((e) => setSendError(getErrorMessage(e)));
  }, [workspaceId]);

  // Screenshot is a round-trip through the platform: the exec asks, the PNG
  // arrives as a screenshot EVENT (fanned out to every viewer, the agent's
  // captures included). Remember the request — when, and for which chat —
  // and attach the first capture that lands after it, whoever took it: it
  // shows the device now. A request nothing answers expires with the exec
  // timeout, so a capture minutes later never attaches to a forgotten click.
  const screenshotRequest = useRef<ScreenshotRequest | null>(null);
  const handleScreenshot = useCallback(() => {
    setSendError(null);
    const request: ScreenshotRequest = {
      askedAt: Date.now(),
      sessionId: activeChatSessionId(workspaceId),
    };
    screenshotRequest.current = request;
    // Forget THIS request only — a newer click must keep its own.
    const forget = () => {
      if (screenshotRequest.current === request) screenshotRequest.current = null;
    };
    const expiry = setTimeout(forget, SCREENSHOT_DEADLINE_MS);
    cloudSimulatorService
      .screenshot(workspaceId)
      .then((res) => {
        if (res.success) return;
        clearTimeout(expiry);
        forget();
        setSendError(res.error || "Screenshot failed");
      })
      .catch((e) => {
        clearTimeout(expiry);
        forget();
        setSendError(getErrorMessage(e));
      });
  }, [workspaceId]);

  const lastScreenshot = device.lastScreenshot;
  useEffect(() => {
    const request = screenshotRequest.current;
    if (!lastScreenshot || !request || lastScreenshot.at < request.askedAt) return;
    screenshotRequest.current = null;
    if (lastScreenshot.at - request.askedAt > SCREENSHOT_DEADLINE_MS) return;
    if (!request.sessionId) return;
    attachScreenshot(request.sessionId, lastScreenshot.base64).catch((e) => {
      setSendError(`Could not attach the screenshot: ${getErrorMessage(e)}`);
    });
  }, [lastScreenshot]);

  const handleAskAgent = useCallback(() => {
    const sid = activeChatSessionId(workspaceId);
    if (sid) sessionComposerActions.appendDraft(sid, BUILD_AND_RUN_PROMPT);
  }, [workspaceId]);

  const header = (
    <CloudSimulatorHeader
      device={device}
      phase={phase}
      onStart={handleStart}
      onStop={handleStop}
      onHome={handleHome}
      onScreenshot={handleScreenshot}
    />
  );

  // Android has no dedicated frame geometry; a phone frame is the honest
  // approximation for both platforms.
  const deviceType = device.platform === "android" ? "Android" : "iPhone";
  const recentActions = device.actions.slice(-VISIBLE_ACTIONS);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="bg-bg-base flex h-full w-full flex-col">
        <div className="relative min-h-0 flex-1">
          <DeviceFrame deviceType={deviceType} header={header}>
            {phase === "live" && device.streamUrl ? (
              <CloudSimulatorScreen
                key={device.streamUrl}
                workspaceId={workspaceId}
                streamUrl={device.streamUrl}
                visible={visible}
              />
            ) : (
              <DeviceStateBody
                // "live" without a URL cannot happen (cloudSimPhase requires the
                // URL); TS can't see through the helper, so read it as booting.
                phase={phase === "live" ? "booting" : phase}
                error={device.error}
                onStart={handleStart}
                onAskAgent={handleAskAgent}
              />
            )}
          </DeviceFrame>
        </div>

        {sendError && (
          <p
            role="alert"
            className="border-border-subtle text-destructive shrink-0 border-t px-3 py-1.5 text-[11px]"
          >
            {sendError}
          </p>
        )}

        {recentActions.length > 0 && <ActionStrip actions={recentActions} />}
      </div>
    </TooltipProvider>
  );
}

/** Everything the frame shows when there is no stream to embed. */
function DeviceStateBody({
  phase,
  error,
  onStart,
  onAskAgent,
}: {
  phase: Exclude<CloudSimPhase, "live">;
  error: string | null;
  onStart: () => void;
  onAskAgent: () => void;
}) {
  return (
    <div className="bg-bg-base flex h-full w-full items-center justify-center p-6 text-center">
      {match(phase)
        .with("idle", () => (
          <div className="flex flex-col items-center gap-3">
            <Button
              onClick={onStart}
              className="min-h-11 min-w-[180px] gap-2 rounded-xl transition-[background-color,border-color,color,box-shadow] duration-150"
            >
              <Play className="h-4 w-4" />
              Start device
            </Button>
            <button
              type="button"
              onClick={onAskAgent}
              className="bg-bg-muted/55 text-text-muted hover:text-text-secondary hover:bg-bg-muted flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors duration-150"
            >
              <Sparkles className="h-3 w-3" />
              Ask the agent to build and run the app
            </button>
          </div>
        ))
        .with("booting", () => (
          <div className="flex flex-col items-center gap-3" aria-live="polite">
            <Loader2 className="text-primary h-6 w-6 animate-spin" />
            <p className="text-text-secondary text-sm font-medium">Booting the device</p>
            <p className="text-text-muted text-xs">About a minute</p>
          </div>
        ))
        .with("stopping", () => (
          <div className="flex flex-col items-center gap-3" aria-live="polite">
            <Loader2 className="text-text-muted h-6 w-6 animate-spin" />
            <p className="text-text-secondary text-sm font-medium">Stopping the device</p>
          </div>
        ))
        .with("error", () => (
          <div className="flex max-w-[240px] flex-col items-center gap-3" aria-live="polite">
            <AlertCircle className="text-destructive h-5 w-5" />
            <p className="text-destructive text-sm leading-5">
              {describeCloudSimulatorError(error)}
            </p>
            <Button
              variant="outline"
              onClick={onStart}
              className="min-h-10 min-w-[136px] gap-2 rounded-xl"
            >
              <RotateCcw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        ))
        .exhaustive()}
    </div>
  );
}

/** The agent's recent device actions (oldest first) — a thin strip so its
 *  activity on the device is visible without opening the chat. */
function ActionStrip({ actions }: { actions: CloudSimActionResult[] }) {
  return (
    <div className="border-border-subtle flex h-7 shrink-0 items-center gap-1.5 overflow-hidden border-t px-3">
      <span className="text-text-muted shrink-0 text-[11px]">Agent</span>
      {actions.map((action) => (
        <span
          key={action.id}
          title={action.error ?? [action.verb, ...action.args].join(" ")}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px]",
            action.success
              ? "bg-bg-muted/50 text-text-secondary"
              : "bg-destructive-tint text-destructive"
          )}
        >
          {action.success ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
          {action.verb}
        </span>
      ))}
    </div>
  );
}
