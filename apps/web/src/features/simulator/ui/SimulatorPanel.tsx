/**
 * SimulatorPanel — iOS simulator viewer and controller.
 *
 * Design direction: "Honest Chrome" — every pixel justifies its existence.
 * - Idle state: centered CTA with ghost device silhouette — no gradient, no noise
 * - Viewport: flat bg-bg-base; the MJPEG stream provides all visual richness
 * - Build progress: collapsible bottom bar — collapsed shows latest line, expand for full log
 * - Status bar: colored dots via semantic tokens (success, warning, destructive)
 *
 * State machine: idle → booting → streaming → building → running → error
 * All conditional rendering driven by a discriminated union via ts-pattern.
 *
 * MJPEG rendering: Frames are loaded into an offscreen <img> (never in the DOM)
 * and painted onto a visible <canvas> via requestAnimationFrame. This avoids
 * WebKit's persistent loading indicator for never-completing HTTP connections.
 * The <canvas> uses max-h-full/max-w-full so getBoundingClientRect() returns
 * the rendered rect for correct touch coordinate normalization.
 *
 * SESSION LIFECYCLE:
 * This component is always-mounted for the app's lifetime (CSS hide/show,
 * same pattern as BrowserPanel). Workspace switches change `workspaceId` prop
 * but do NOT unmount the component.
 *
 * The `state` (SimPhase) lives in the global Zustand store, keyed by
 * workspaceId. This means:
 * - Workspace A streams → switch to B → A's streaming state persists in store
 * - Switch back to A → component reads store, sees "streaming" immediately
 * - No IPC round-trip, no async probe, no idle flash on switch-back
 *
 * The native session (ScreenCapture + MjpegServer) is managed independently in
 * SimulatorSessions (HashMap<workspace_id, SimSession>). Its lifetime is:
 *   Created: user clicks Start (or agent calls SimulatorStart)
 *   Destroyed: user clicks Stop (or app closes — handled in Electron main)
 * It is NEVER destroyed on workspace switch. The component does not own
 * the native session — it is a view onto it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { match } from "ts-pattern";
import {
  Smartphone,
  Play,
  Square,
  Home,
  RotateCcw,
  Loader2,
  Rocket,
  AlertCircle,
  Camera,
  Check,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/shared/lib/utils";
import { getErrorMessage } from "@shared/lib/errors";
import { listen, SIM_BUILD_LOG } from "@/platform/electron";
import { simulatorService } from "../api/simulator.service";
import { useSimulatorRpcHandler } from "../automation/useSimulatorRpcHandler";
import { useSimulatorStatusStore, simulatorStoreActions } from "../store";
import { hasStream } from "../machine";
import type { SimPhase } from "../store";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { chatInsertActions } from "@/shared/stores/chatInsertStore";
import type { SimulatorInfo } from "../types";
import { SimulatorStreamViewer } from "./SimulatorStreamViewer";
import { SimulatorAppBar } from "./SimulatorAppBar";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SimulatorPanelProps {
  workspaceId: string;
  workspacePath: string;
}

// ---------------------------------------------------------------------------
// Build log ring buffer size — keeps memory bounded during long builds
// ---------------------------------------------------------------------------

const MAX_BUILD_LOG_LINES = 50;

// ---------------------------------------------------------------------------
// Device scoring — iPhones first, booted first, exclude pool/test devices
// ---------------------------------------------------------------------------

function scoreSimulator(sim: SimulatorInfo): number {
  let score = 0;
  if (sim.device_type.includes("iPhone")) score += 1000;
  else if (sim.device_type.includes("iPad")) score += 100;
  if (sim.state === "Booted") score += 500;
  if (sim.name.toLowerCase().includes("pool") || sim.name.toLowerCase().includes("test"))
    score -= 5000;
  return score;
}

// Score by device type only — excludes Booted bonus. Used when a workspace has
// no persisted UDID so we don't auto-select a sim booted by another workspace.
function scoreSimulatorByType(sim: SimulatorInfo): number {
  let score = 0;
  if (sim.device_type.includes("iPhone")) score += 1000;
  else if (sim.device_type.includes("iPad")) score += 100;
  if (sim.name.toLowerCase().includes("pool") || sim.name.toLowerCase().includes("test"))
    score -= 5000;
  return score;
}

// Referentially stable idle sentinel — prevents spurious re-renders.
// Zustand's selector compares previous and next values with Object.is().
// `sessions[id] ?? { phase: "idle" }` creates a new object reference every
// render when the workspace has no session entry, causing the selector to
// always return "changed" and triggering unnecessary re-renders. By using a
// module-level constant, absent entries always return the same reference.
const IDLE_PHASE: SimPhase = { phase: "idle" };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SimulatorPanel({ workspaceId, workspacePath }: SimulatorPanelProps) {
  const [simulators, setSimulators] = useState<SimulatorInfo[] | null>(null);
  const [selectedUdid, setSelectedUdid] = useState<string | null>(null);

  // Ref mirror of selectedUdid for reading inside async callbacks without
  // closing over the state value (avoids recreating useCallback dependencies).
  // Updated atomically via updateSelectedUdid — never written during render.
  const selectedUdidRef = useRef(selectedUdid);
  const updateSelectedUdid = useCallback((udid: string | null) => {
    selectedUdidRef.current = udid;
    setSelectedUdid(udid);
  }, []);

  // ---------------------------------------------------------------------------
  // DISPLAY PLANE — session phase from the global store, not local useState.
  //
  // SimulatorPanel is always-mounted (no `key` on the parent ResizablePanelGroup).
  // On workspace switch, only the `workspaceId` prop changes — the component
  // instance stays alive. The store is keyed by workspaceId and lives
  // independently of React's prop changes.
  //
  // On workspace switch (prop change):
  //   • Store has a live phase for new workspace → streamUrl is non-null →
  //     MJPEG effect reconnects immediately with zero IPC calls.
  //   • Store has idle + native session exists → mount effect probes and upgrades.
  //   • Store has idle + no native session → user sees idle, clicks Start.
  //
  // The three planes are fully disentangled:
  //   Component plane  — always-mounted, workspaceId prop changes on switch
  //   Display plane    — this store, keyed by workspaceId, persists across switches
  //   Session plane    — native HashMap, created by Start, destroyed by Stop only
  // ---------------------------------------------------------------------------
  const state: SimPhase = useSimulatorStatusStore((s) => s.sessions[workspaceId] ?? IDLE_PHASE);

  // Two write paths — dispatch() validates transitions via the state machine;
  // setSession() bypasses validation for recovery paths (mount probes, agent-driven).
  // User-driven actions always go through dispatch() to catch illegal transitions.

  // Whether this workspace has a buildable Xcode project (null = still checking).
  // Gates the "Build & Run" button — simulator streaming works regardless.
  const [hasProject, setHasProject] = useState<boolean | null>(null);

  // Monotonic generation counter — incremented each mount cycle so async
  // callbacks can detect if this component unmounted before they resolved.
  const workspaceGenerationRef = useRef(0);

  // On mount: restore persisted UDID + probe backend for app-restart recovery.
  //
  // App-restart scenario: backend process was killed and restarted (no sessions),
  // but the store still has { phase: "idle" } for this workspace. Meanwhile the
  // simulator was left booted. We probe get_stream_info once (fast read,
  // ~1ms) — if the backend already has a session we reconnect; if not, we stay idle
  // and the auto-reconnect effect below will re-establish streaming if the
  // selected sim is still "Booted".
  //
  // Normal workspace switch: the store already holds the correct phase from the
  // previous visit.  The MJPEG effect reacts to the non-null streamUrl from the
  // store and reconnects immediately.  This mount probe is then a no-op (the
  // phase is not idle, so the getStreamInfo call is skipped).
  useEffect(() => {
    workspaceGenerationRef.current += 1;
    const gen = workspaceGenerationRef.current;

    const layout = workspaceLayoutActions.getLayout(workspaceId);
    // Always reset selectedUdid on workspace switch — either to this workspace's
    // persisted UDID or null. Without this, the always-mounted component retains
    // the previous workspace's UDID, causing loadSimulators to skip re-selection
    // and default to a sim that's already in use by another workspace.
    const persistedUdid = layout.simulatorUdid ?? null;
    updateSelectedUdid(persistedUdid);

    // Probe backend if the display plane shows idle OR stuck at booting.
    // Idle: normal first-mount or app-restart where backend may already have a session.
    // Booting: recovery for rare edge case where the async completion was lost
    // (e.g. app crashed mid-boot). If backend has a live stream, upgrade to streaming.
    // If backend has nothing, reset to idle so the user can retry.
    const currentPhase = simulatorStoreActions.getSession(workspaceId).phase;
    if ((currentPhase === "idle" || currentPhase === "booting") && layout.simulatorUdid) {
      simulatorService.getStreamInfo(workspaceId).then((stream) => {
        if (workspaceGenerationRef.current !== gen) return;
        if (stream) {
          simulatorStoreActions.setSession(workspaceId, {
            phase: "streaming",
            udid: layout.simulatorUdid!,
            stream,
          });
          updateSelectedUdid(layout.simulatorUdid!);
        } else if (currentPhase === "booting") {
          // Backend has no session but store says booting — stuck state, reset.
          simulatorStoreActions.clearWorkspaceSession(workspaceId);
        }
      });
    }
    // Runs on every workspace switch (workspaceId prop changes — always-mounted component).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // -- Agent-driven boot callback (used by SimulatorStart RPC) --
  // Extracted so the RPC handler can trigger panel state transitions
  // when the agent calls SimulatorStart. Same flow as handleStart()
  // but returns StreamInfo for the RPC response.
  const handleBootSimulator = useCallback(
    async (udid: string) => {
      // Reassign: release device from any other workspace first.
      const ownerWsId = simulatorStoreActions.getWorkspaceByUdid(udid, workspaceId);
      if (ownerWsId) {
        simulatorService.stopStreaming(ownerWsId).catch(() => {});
        simulatorStoreActions.clearWorkspaceSession(ownerWsId);
      }
      updateSelectedUdid(udid);
      workspaceLayoutActions.setSimulatorUdid(workspaceId, udid);
      // Single write — setSession updates both the full session and the label.
      simulatorStoreActions.setSession(workspaceId, { phase: "booting", udid });
      // Auto-switch to simulator tab so the user sees the stream
      // (same pattern as BrowserPanel's onAutoCreateTab)
      workspaceLayoutActions.setActiveContentTab(workspaceId, "simulator");

      try {
        // Skip boot check — agent-driven boot has already verified the UDID.
        const stream = await simulatorService.startStreaming(workspaceId, udid, true);
        simulatorStoreActions.setSession(workspaceId, { phase: "streaming", udid, stream });
        return stream;
      } catch (e) {
        const msg = getErrorMessage(e);
        simulatorStoreActions.setSession(workspaceId, {
          phase: "error",
          message: `Failed to start: ${msg}`,
          canRetry: true,
        });
        return null;
      }
    },
    [updateSelectedUdid, workspaceId]
  );

  // Listen for simulator RPC requests from the agent-server (agent tools)
  useSimulatorRpcHandler({
    workspaceId,
    onBootSimulator: handleBootSimulator,
    getSimulators: useCallback(() => simulators, [simulators]),
  });

  // Probe for Xcode project on mount and when workspace changes.
  // Fast filesystem scan via IPC — no xcodebuild, no side effects.
  useEffect(() => {
    let cancelled = false;

    setHasProject(null);
    simulatorService.hasXcodeProject(workspacePath).then(
      (result) => {
        if (!cancelled) setHasProject(result);
      },
      () => {
        if (!cancelled) setHasProject(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  // Build log accumulator — stores last N lines for the build drawer
  const [buildLogs, setBuildLogs] = useState<string[]>([]);
  const buildLogEndRef = useRef<HTMLDivElement>(null);

  // Listen for build log events streamed from Electron main during xcodebuild.
  // Payload is { workspaceId, line } — filter to only this workspace so
  // concurrent builds in different workspaces don't interleave logs.
  useEffect(() => {
    if (state.phase !== "building") {
      setBuildLogs([]);
      return;
    }
    let unlisten: (() => void) | null = null;
    listen(SIM_BUILD_LOG, (event) => {
      if (event.payload.workspaceId !== workspaceId) return;
      setBuildLogs((prev) => {
        const next = [...prev, event.payload.line];
        return next.length > MAX_BUILD_LOG_LINES ? next.slice(-MAX_BUILD_LOG_LINES) : next;
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [state.phase, workspaceId]);

  // Auto-scroll build log to bottom when new lines arrive
  useEffect(() => {
    buildLogEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [buildLogs]);

  // Filter to iOS-capable simulators
  const iosSimulators = useMemo(
    () =>
      (simulators ?? [])
        .filter(
          (s) =>
            s.runtime.includes("iOS") ||
            s.device_type.includes("iPhone") ||
            s.device_type.includes("iPad")
        )
        .sort((a, b) => scoreSimulator(b) - scoreSimulator(a)),
    [simulators]
  );

  const selectedSim = useMemo(
    () => iosSimulators.find((s) => s.udid === selectedUdid),
    [iosSimulators, selectedUdid]
  );

  // Whether device select should be disabled (any active state)
  const selectDisabled = state.phase !== "idle";

  // Stream URL and HID availability — derived from the state machine guard.
  const streamUrl = hasStream(state) ? state.stream.url : null;
  const hidAvailable = hasStream(state) ? state.stream.hid_available : true;
  const isLive = streamUrl !== null;

  // -------------------------------------------------------------------------
  // Load simulators on mount
  // -------------------------------------------------------------------------

  const loadSimulators = useCallback(async () => {
    const gen = workspaceGenerationRef.current;
    try {
      const sims = await simulatorService.listSimulators();
      if (workspaceGenerationRef.current !== gen) return; // Guard: workspace may have changed
      setSimulators(sims);

      const currentUdid = selectedUdidRef.current;
      // Pick a UDID when: nothing selected, OR current selection is stale (not in list)
      const needsSelection = !currentUdid || !sims.some((s) => s.udid === currentUdid);
      if (needsSelection && sims.length > 0) {
        // Check persisted UDID first — if it exists in the sim list, use it.
        // Otherwise fall back to scoring by device type only (NOT boot state).
        // We exclude the Booted bonus so a sim booted by another workspace
        // doesn't get auto-selected and then trigger auto-reconnect here.
        const layout = workspaceLayoutActions.getLayout(workspaceId);
        const persisted = layout.simulatorUdid;
        if (persisted && sims.some((s) => s.udid === persisted)) {
          updateSelectedUdid(persisted);
        } else {
          const iosSims = sims.filter(
            (s) =>
              s.runtime.includes("iOS") ||
              s.device_type.includes("iPhone") ||
              s.device_type.includes("iPad")
          );
          // Progressive fallback: prefer idle devices, then non-store-claimed,
          // then anything. Avoids auto-selecting a booted sim from another
          // workspace (or from Xcode) which causes "same stream" confusion.
          const inUse = simulatorStoreActions.getInUseUdids(workspaceId);
          const idle = iosSims.filter((s) => s.state !== "Booted" && !inUse.has(s.udid));
          const notClaimed = iosSims.filter((s) => !inUse.has(s.udid));
          const pool = idle.length > 0 ? idle : notClaimed.length > 0 ? notClaimed : iosSims;
          const scored = [...pool].sort(
            (a, b) => scoreSimulatorByType(b) - scoreSimulatorByType(a)
          );
          updateSelectedUdid(scored[0]?.udid ?? sims[0].udid);
        }
      }
    } catch (e) {
      if (workspaceGenerationRef.current !== gen) return; // Guard: workspace may have changed
      // setSession (not dispatch) — the machine rejects ERROR from idle, but
      // discovery failures can happen during initial load when the phase is idle.
      // This is orthogonal to the session lifecycle.
      simulatorStoreActions.setSession(workspaceId, {
        phase: "error",
        message: `Failed to load simulators: ${getErrorMessage(e)}`,
        canRetry: false,
      });
    }
  }, [updateSelectedUdid, workspaceId]);

  useEffect(() => {
    loadSimulators();
  }, [loadSimulators]);

  // -------------------------------------------------------------------------
  // Auto-reconnect to an already-booted simulator (app-restart recovery).
  //
  // The mount effect above handles the fast path: if the backend already has a
  // session in memory (normal run), it reconnects immediately via getStreamInfo.
  //
  // This effect handles the slower path: backend was restarted (no sessions in
  // memory), but simctl still shows the simulator as "Booted". We re-establish
  // the MJPEG capture by calling startStreaming.
  //
  // Fires only when:
  //   - Phase is idle (mount effect found no backend session, or user never started)
  //   - The selected simulator is actually booted
  //   - This workspace previously claimed this simulator (ownership guard)
  //
  // The store-based display plane means this effect fires at most once per mount
  // cycle: once it transitions to "booting" or "streaming", state.phase is no
  // longer "idle", so the effect will not re-run.
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (state.phase !== "idle") return;
    if (!selectedSim || selectedSim.state !== "Booted") return;

    // OWNERSHIP GUARD: Only auto-reconnect if this workspace previously claimed
    // this simulator. layout.simulatorUdid is written ONLY by explicit user/agent
    // start actions. A workspace that never started a sim has no persisted UDID,
    // so an ambient booted sim from another workspace won't trigger auto-connect.
    const layout = workspaceLayoutActions.getLayout(workspaceId);
    if (layout.simulatorUdid !== selectedSim.udid) return;

    const gen = workspaceGenerationRef.current;
    const udid = selectedSim.udid;

    // Re-establish streaming for an orphaned booted simulator (app-restart case).
    // setSession (not dispatch) — this is a recovery path, not a user action.
    // Transitions to "booting" immediately so this effect won't fire again.
    simulatorStoreActions.setSession(workspaceId, { phase: "booting", udid });
    simulatorService.startStreaming(workspaceId, udid).then(
      (stream) => {
        if (workspaceGenerationRef.current !== gen) return;
        simulatorStoreActions.setSession(workspaceId, { phase: "streaming", udid, stream });
      },
      () => {
        if (workspaceGenerationRef.current !== gen) return;
        // Silently fall back to idle — don't surface error for auto-reconnect.
        // The user can manually start if they want to use the simulator.
        simulatorStoreActions.clearWorkspaceSession(workspaceId);
      }
    );
  }, [selectedSim, workspaceId, state.phase]);

  // -------------------------------------------------------------------------
  // Start — boot simulator and begin streaming (no build)
  // -------------------------------------------------------------------------

  const handleStart = async () => {
    if (!selectedUdid) return;
    // If another workspace owns this device, release it first (reassignment).
    // The user chose this device explicitly or it was auto-selected — either way,
    // one device = one workspace at a time.
    const ownerWsId = simulatorStoreActions.getWorkspaceByUdid(selectedUdid, workspaceId);
    if (ownerWsId) {
      simulatorService.stopStreaming(ownerWsId).catch(() => {});
      simulatorStoreActions.clearWorkspaceSession(ownerWsId);
    }
    // dispatch validates: BOOT is only legal from idle or error (retry).
    if (!simulatorStoreActions.dispatch(workspaceId, { type: "BOOT", udid: selectedUdid })) return;
    // Skip the simctl boot check if the frontend already knows the device is booted
    // (saves 1-10s of `simctl list --json` parsing).
    const isBooted = selectedSim?.state === "Booted";
    try {
      const stream = await simulatorService.startStreaming(workspaceId, selectedUdid, isBooted);
      if (!stream.hid_available) {
        console.warn("[Simulator] HID client not available — touch/scroll/key injection disabled");
      }
      // No gen guard: dispatch targets the originating workspace by workspaceId,
      // so the write is correct even if the user switched away mid-boot.
      simulatorStoreActions.dispatch(workspaceId, {
        type: "STREAM_READY",
        udid: selectedUdid,
        stream,
      });
      workspaceLayoutActions.setSimulatorUdid(workspaceId, selectedUdid);
    } catch (e) {
      simulatorStoreActions.dispatch(workspaceId, {
        type: "ERROR",
        message: `Failed to boot simulator: ${getErrorMessage(e)}`,
        canRetry: true,
      });
    }
  };

  // Build & Run — build project and launch on already-streaming simulator.
  // dispatch validates: BUILD_START is only legal from streaming or running.
  const handleBuildAndRun = async () => {
    if (
      !simulatorStoreActions.dispatch(workspaceId, { type: "BUILD_START", startedAt: Date.now() })
    )
      return;
    try {
      const app = await simulatorService.buildAndRun(workspaceId, workspacePath);
      // No gen guard: dispatch targets the originating workspace by workspaceId.
      simulatorStoreActions.dispatch(workspaceId, { type: "BUILD_SUCCESS", app });
    } catch (e) {
      simulatorStoreActions.dispatch(workspaceId, {
        type: "ERROR",
        message: `Build failed: ${getErrorMessage(e)}`,
        canRetry: true,
      });
    }
  };

  // Stop everything — destroys the native session and returns display plane to idle.
  //
  // This is the ONLY place in the frontend that should destroy a native session
  // (besides app close, handled in Electron main).  Component unmount does NOT call
  // stopStreaming — that would destroy live sessions on workspace switch.
  const handleStop = async () => {
    // dispatch STOP transitions any active state → idle (auto-deleted from map).
    simulatorStoreActions.dispatch(workspaceId, { type: "STOP" });
    try {
      await simulatorService.stopStreaming(workspaceId);
    } catch (e) {
      console.error("Stop failed:", e);
    }
  };

  // Retry from error state — CLEAR force-resets to idle, then starts fresh.
  const handleRetry = () => {
    simulatorStoreActions.dispatch(workspaceId, { type: "CLEAR" });
    handleStart();
  };

  // Home button
  const handleHome = async () => {
    try {
      await simulatorService.pressHome(workspaceId);
    } catch (e) {
      console.error("Home button failed:", e);
    }
  };

  // App management
  const handleRelaunch = async () => {
    if (state.phase !== "running") return;
    try {
      await simulatorService.launchApp(workspaceId, state.app.bundle_id);
    } catch (e) {
      console.error("Relaunch failed:", e);
    }
  };

  const handleTerminate = async () => {
    if (state.phase !== "running") return;
    const gen = workspaceGenerationRef.current;
    try {
      await simulatorService.terminateApp(workspaceId, state.app.bundle_id);
      if (workspaceGenerationRef.current !== gen) return;
      // App process killed but still installed — drop back to streaming.
      simulatorStoreActions.dispatch(workspaceId, { type: "APP_UNINSTALLED" });
    } catch (e) {
      console.error("Terminate failed:", e);
    }
  };

  const handleUninstall = async () => {
    if (state.phase !== "running") return;
    const gen = workspaceGenerationRef.current;
    try {
      await simulatorService.uninstallApp(workspaceId, state.app.bundle_id);
      if (workspaceGenerationRef.current !== gen) return; // Guard: workspace may have changed
      // dispatch validates: APP_UNINSTALLED is only legal from running → streaming.
      simulatorStoreActions.dispatch(workspaceId, { type: "APP_UNINSTALLED" });
    } catch (e) {
      console.error("Uninstall failed:", e);
    }
  };

  // -------------------------------------------------------------------------
  // Screenshot — capture PNG and insert into chat input
  // -------------------------------------------------------------------------

  const handleScreenshot = useCallback(async () => {
    try {
      const bytes = await simulatorService.takeScreenshot(workspaceId);
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
      const file = new File([blob], `simulator-screenshot-${Date.now()}.png`, {
        type: "image/png",
      });
      chatInsertActions.insertFiles(workspaceId, [file]);
    } catch (e) {
      console.error("Screenshot failed:", e);
    }
  }, [workspaceId]);

  // -------------------------------------------------------------------------
  // Empty state — no simulators installed
  // -------------------------------------------------------------------------

  if (simulators === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (iosSimulators.length === 0 && state.phase !== "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Smartphone className="text-text-muted h-8 w-8" />
        <div>
          <p className="text-text-secondary text-sm font-medium">No iOS Simulators</p>
          <p className="text-text-muted mt-1 text-xs">
            Open Xcode and create a simulator to get started.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadSimulators}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------------------

  const isBuilding = state.phase === "building";

  return (
    <div className="flex h-full flex-col">
      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <div className="border-border-subtle flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <TooltipProvider delayDuration={200}>
          {/* Status dot — reflects current phase, sits left of the selector */}
          <div
            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", {
              "bg-muted-foreground/50": state.phase === "idle",
              "bg-warning animate-pulse": state.phase === "booting" || state.phase === "building",
              "bg-success": state.phase === "streaming" || state.phase === "running",
              "bg-destructive": state.phase === "error",
            })}
          />

          {/* Device selector — lightweight dropdown matching file-browser filter style */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                disabled={selectDisabled}
                aria-label="Select simulator device"
                aria-haspopup="listbox"
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-lg py-1 text-xs transition-colors duration-200 ease-[ease] disabled:pointer-events-none disabled:opacity-50"
              >
                <Smartphone className="h-[11px] w-[11px] shrink-0" />
                <span className="truncate">
                  {selectedSim
                    ? `${selectedSim.name}  ${selectedSim.runtime.replace("com.apple.CoreSimulator.SimRuntime.", "")}`
                    : "Select simulator..."}
                </span>
                <ChevronDown className="h-[10px] w-[10px] shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[200px]">
              {iosSimulators.map((sim) => (
                <DropdownMenuItem
                  key={sim.udid}
                  onClick={() => {
                    updateSelectedUdid(sim.udid);
                    workspaceLayoutActions.setSimulatorUdid(workspaceId, sim.udid);
                  }}
                  className="gap-2 text-xs"
                >
                  <Check
                    className={cn(
                      "h-3 w-3 shrink-0",
                      selectedUdid === sim.udid ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {sim.state === "Booted" && (
                    <span className="bg-success h-1.5 w-1.5 shrink-0 rounded-full" />
                  )}
                  <span className="truncate">{sim.name}</span>
                  <span className="text-text-muted ml-auto text-xs">
                    {sim.runtime.replace("com.apple.CoreSimulator.SimRuntime.", "")}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Spacer — pushes action buttons to the right */}
          <div className="flex-1" />

          {/* No-touch warning — inline in toolbar when HID is unavailable */}
          {isLive && !hidAvailable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-warning flex cursor-help items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  <span className="text-xs">No touch</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[220px]">
                <p className="text-xs">
                  HID client not available. Touch, scroll, and keyboard input won't work. Check
                  Xcode/Simulator.app installation.
                </p>
              </TooltipContent>
            </Tooltip>
          )}

          {/* Primary action — morphs based on state. Idle CTA is in the viewport, not here. */}
          {match(state)
            .with({ phase: "idle" }, () => null)
            .with({ phase: "booting" }, () => (
              <Button variant="outline" size="sm" disabled className="h-7 gap-1.5 px-2.5 text-xs">
                <Loader2 className="h-3 w-3 animate-spin" />
                Booting
              </Button>
            ))
            .with({ phase: "streaming" }, () =>
              hasProject ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBuildAndRun}
                  className="h-7 gap-1.5 px-2.5 text-xs"
                >
                  <Rocket className="h-3 w-3" />
                  Build & Run
                </Button>
              ) : hasProject === false ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex cursor-not-allowed">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled
                        className="h-7 gap-1.5 px-2.5 text-xs opacity-40"
                      >
                        <Rocket className="h-3 w-3" />
                        Build & Run
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    No Xcode project found in this workspace
                  </TooltipContent>
                </Tooltip>
              ) : null
            )
            .with({ phase: "building" }, () => (
              <Button variant="outline" size="sm" disabled className="h-7 gap-1.5 px-2.5 text-xs">
                <Loader2 className="h-3 w-3 animate-spin" />
                Building
              </Button>
            ))
            .with({ phase: "running" }, () =>
              hasProject ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBuildAndRun}
                  className="h-7 gap-1.5 px-2.5 text-xs"
                >
                  <RotateCcw className="h-3 w-3" />
                  Rebuild
                </Button>
              ) : null
            )
            .with({ phase: "error" }, (s) =>
              s.canRetry ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRetry}
                  className="h-7 gap-1.5 px-2.5 text-xs"
                >
                  <RotateCcw className="h-3 w-3" />
                  Retry
                </Button>
              ) : null
            )
            .exhaustive()}

          {/* Stop button — visible in all active states */}
          {state.phase !== "idle" && state.phase !== "error" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={handleStop} className="h-7 w-7 p-0">
                  <Square className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Stop simulator</TooltipContent>
            </Tooltip>
          )}

          {/* Home button — visible when streaming */}
          {isLive && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={handleHome} className="h-7 w-7 p-0">
                  <Home className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Home</TooltipContent>
            </Tooltip>
          )}

          {/* Screenshot — visible when streaming */}
          {isLive && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleScreenshot}
                  className="h-7 w-7 p-0"
                >
                  <Camera className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Screenshot ⌘⇧S</TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
      </div>

      {/* ── Viewport — MJPEG stream + overlay states ───────────── */}
      <SimulatorStreamViewer
        workspaceId={workspaceId}
        streamUrl={streamUrl}
        isLive={isLive}
        hidAvailable={hidAvailable}
        onScreenshot={handleScreenshot}
      >
        {/* Overlay states on top of (or instead of) the stream */}
        {match(state)
          .with({ phase: "idle" }, () => (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-5">
              {/* Device silhouette — ghost outline at reduced opacity.
               * Breathing animation oscillates opacity; reduced-motion users
               * get a static value via motion-safe gating. */}
              <svg
                width="100"
                height="210"
                viewBox="0 0 100 210"
                fill="none"
                className="opacity-30 motion-safe:animate-[sim-idle-breathe_6s_ease-in-out_infinite]"
              >
                <rect
                  x="1"
                  y="1"
                  width="98"
                  height="208"
                  rx="22"
                  className="stroke-muted-foreground/20"
                  strokeWidth="1.5"
                />
                <rect
                  x="34"
                  y="12"
                  width="32"
                  height="10"
                  rx="5"
                  className="fill-muted-foreground/10"
                />
                <rect
                  x="35"
                  y="196"
                  width="30"
                  height="3"
                  rx="1.5"
                  className="fill-muted-foreground/10"
                />
              </svg>

              <div className="flex flex-col items-center gap-1.5">
                <p className="text-text-secondary text-sm font-medium">
                  {selectedSim?.name ?? "No simulator selected"}
                </p>
                {selectedSim && (
                  <p className="text-text-muted text-xs">
                    {selectedSim.runtime.replace("com.apple.CoreSimulator.SimRuntime.", "")}
                  </p>
                )}
              </div>

              {/* Primary CTA — the only actionable element in idle state */}
              <Button
                onClick={handleStart}
                disabled={!selectedUdid}
                className="min-w-[140px] gap-2"
              >
                <Play className="h-4 w-4" />
                Start Simulator
              </Button>

              {hasProject === false && (
                <p className="text-text-muted max-w-[220px] text-center text-xs">
                  No Xcode project found. You can still use the simulator, but Build & Run is not
                  available.
                </p>
              )}
            </div>
          ))
          .with({ phase: "booting" }, () => (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <Loader2 className="text-primary h-6 w-6 animate-spin" />
              <p className="text-text-secondary text-xs">Booting simulator...</p>
            </div>
          ))
          .with({ phase: "error" }, (s) => (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
              <AlertCircle className="text-destructive/70 h-5 w-5" />
              <p className="text-destructive max-w-[240px] text-center text-xs">{s.message}</p>
              {s.canRetry && (
                <Button variant="outline" size="sm" onClick={handleRetry} className="h-7 text-xs">
                  <RotateCcw className="mr-1.5 h-3 w-3" />
                  Try Again
                </Button>
              )}
            </div>
          ))
          .otherwise(() => null)}
      </SimulatorStreamViewer>

      {/* ── Build drawer — collapsible bar below the stream ────────── */}
      {isBuilding && (
        <BuildDrawer
          startedAt={(state as Extract<SimPhase, { phase: "building" }>).startedAt}
          logs={buildLogs}
          logEndRef={buildLogEndRef}
        />
      )}

      {/* ── App bar — bottom strip when app is running ──────────── */}
      {state.phase === "running" && (
        <SimulatorAppBar
          app={state.app}
          onRelaunch={handleRelaunch}
          onTerminate={handleTerminate}
          onUninstall={handleUninstall}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BuildDrawer — collapsible log pane anchored at the bottom of the panel
// during builds. Collapsed by default: shows only a slim header strip with
// the latest log line. Click the header to expand and see the full log.
//
// Collapsed: fixed-height bar (~28px) — shimmer + amber dot + latest line + timer + chevron
// Expanded: max-h-[40%] panel — header + scrollable monospace log body
// ---------------------------------------------------------------------------

function BuildDrawer({
  startedAt,
  logs,
  logEndRef,
}: {
  startedAt: number;
  logs: string[];
  logEndRef: React.RefObject<HTMLDivElement>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const formatted = `${minutes}:${String(seconds).padStart(2, "0")}`;

  // Latest log line for the collapsed preview — trim verbose xcodebuild paths
  const latestLine = logs.length > 0 ? logs[logs.length - 1] : "Waiting for build output...";

  return (
    <div
      className={cn(
        "border-border-subtle flex shrink-0 flex-col border-t",
        expanded && "max-h-[40%]"
      )}
    >
      {/* Shimmer bar — 2px progress indicator at the top edge of the drawer */}
      <div className="h-0.5 shrink-0 overflow-hidden">
        <div className="bg-primary/80 h-full w-1/3 animate-[build-shimmer_1.8s_cubic-bezier(.165,.84,.44,1)_infinite]" />
      </div>

      {/* Header strip — click to toggle log body. Shows latest line when collapsed. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="bg-bg-surface ease hover:bg-bg-surface/80 flex h-7 shrink-0 items-center gap-2 px-3 transition-colors duration-200"
      >
        <span className="bg-warning h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" />
        <span className="text-text-secondary text-xs font-medium">Building</span>

        {/* Collapsed preview — truncated latest log line */}
        {!expanded && (
          <span className="text-text-muted min-w-0 flex-1 truncate px-2 text-left font-mono text-xs">
            {latestLine}
          </span>
        )}

        <span className="ml-auto flex items-center gap-2">
          <span className="text-text-muted font-mono text-xs tabular-nums">{formatted}</span>
          <ChevronDown
            className={cn(
              "text-text-muted h-3 w-3 transition-transform duration-200",
              expanded && "rotate-180"
            )}
          />
        </span>
      </button>

      {/* Scrollable log body — only visible when expanded */}
      {expanded && (
        <div className="bg-bg-base flex-1 overflow-y-auto px-3 py-2">
          {logs.length === 0 ? (
            <p className="text-text-muted font-mono text-xs leading-relaxed">
              Waiting for build output...
            </p>
          ) : (
            logs.map((line, i) => (
              <p
                key={i}
                className={cn(
                  "font-mono text-xs leading-relaxed",
                  i === logs.length - 1 ? "text-text-secondary" : "text-text-muted",
                  line.includes("error:") && "text-destructive",
                  line.includes("warning:") && "text-warning"
                )}
              >
                {line}
              </p>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}
