/**
 * SimulatorPanel — iOS simulator viewer and controller.
 *
 * State lives in a workspace-keyed Zustand store. Native simulator sessions
 * survive workspace switches and stop only on explicit Stop or app shutdown.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { match } from "ts-pattern";
import { ChevronDown, Crosshair, Loader2, RotateCcw, Send, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { getErrorMessage } from "@shared/lib/errors";
import { onEvent } from "@/platform/ws/query-protocol-client";
import { simulatorService } from "../api/simulator.service";

import { useSimulatorStatusStore, simulatorStoreActions } from "../store";
import { hasStream } from "../machine";
import type { SimPhase } from "../store";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";
import { processImageFiles } from "@/features/session/lib/imageAttachments";
import type { InspectorNode, InspectorSnapshot, SimulatorInfo } from "../types";
import { SimulatorStreamViewer } from "./SimulatorStreamViewer";
import { SimulatorAppBar } from "./SimulatorAppBar";
import { SimulatorContentHeader } from "./SimulatorContentHeader";
import { SimulatorDeviceHeader } from "./SimulatorDeviceHeader";
import { SimulatorEmptySurface } from "./SimulatorEmptySurface";
import { SimulatorLaunchPreview } from "./SimulatorLaunchPreview";

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

function inspectorPathForNode(snapshot: InspectorSnapshot | null, target: InspectorNode): string {
  const parents = new Map<string, InspectorNode>();
  const walk = (node: InspectorNode) => {
    for (const child of node.children) {
      parents.set(child.id, node);
      walk(child);
    }
  };
  for (const root of snapshot?.roots ?? []) walk(root);
  const path = [target.className];
  let current = parents.get(target.id);
  while (current) {
    path.unshift(current.className);
    current = parents.get(current.id);
  }
  return path.slice(-6).join(" > ");
}

function inspectorPropsForNode(node: InspectorNode): string {
  const props = node.properties ?? {};
  const entries = Object.entries(props).slice(0, 12);
  const rect = node.screenRect;
  return [
    `screenRect=${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}×${Math.round(rect.height)}`,
    `alpha=${node.alpha}`,
    `hidden=${node.hidden}`,
    ...entries.map(([key, value]) => `${key}=${value}`),
  ].join("; ");
}

// ---------------------------------------------------------------------------
// Device scoring — iPhones first, booted first, exclude pool/test devices.
// `scoreSimulatorByType` skips the Booted bonus; used when a workspace has no
// persisted UDID so we don't auto-select a sim booted by another workspace.
// ---------------------------------------------------------------------------

function scoreSimulatorByType(sim: SimulatorInfo): number {
  let score = 0;
  if (sim.device_type.includes("iPhone")) score += 1000;
  else if (sim.device_type.includes("iPad")) score += 100;
  const name = sim.name.toLowerCase();
  if (name.includes("pool") || name.includes("test")) score -= 5000;
  return score;
}

function scoreSimulator(sim: SimulatorInfo): number {
  return scoreSimulatorByType(sim) + (sim.state === "Booted" ? 500 : 0);
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
  const simulatorSessions = useSimulatorStatusStore((s) => s.sessions);

  // Two write paths — dispatch() validates transitions via the state machine;
  // setSession() bypasses validation for recovery paths (mount probes, agent-driven).
  // User-driven actions always go through dispatch() to catch illegal transitions.

  // Whether this workspace has a buildable Xcode project (null = still checking).
  // Gates the "Build & Run" button — simulator streaming works regardless.
  const [hasProject, setHasProject] = useState<boolean | null>(null);

  // Monotonic generation counter — incremented each mount cycle so async
  // callbacks can detect if this component unmounted before they resolved.
  const workspaceGenerationRef = useRef(0);

  // On workspace switch / mount: restore persisted UDID + recover stuck booting state.
  //
  // Normal workspace switch: the store already holds the correct phase from the
  // previous visit. The MJPEG effect reacts to the non-null streamUrl from the
  // store and reconnects immediately — no IPC round-trip.
  //
  // Stream recovery on app-restart now flows through the sim:streamReady event
  // pushed by the backend on reconnect, not a polled probe.
  useEffect(() => {
    workspaceGenerationRef.current += 1;

    const layout = workspaceLayoutActions.getLayout(workspaceId);
    // Always reset selectedUdid on workspace switch — either to this workspace's
    // persisted UDID or null. Without this, the always-mounted component retains
    // the previous workspace's UDID, causing loadSimulators to skip re-selection
    // and default to a sim that's already in use by another workspace.
    //
    // If this workspace's persisted UDID is already streaming in another workspace,
    // clear it to force re-selection of a different device (multi-simulator support).
    const persistedUdid = layout.simulatorUdid ?? null;
    const inUse = simulatorStoreActions.getInUseUdids(workspaceId);
    const effectiveUdid = persistedUdid && inUse.has(persistedUdid) ? null : persistedUdid;
    if (effectiveUdid !== persistedUdid) {
      workspaceLayoutActions.setSimulatorUdid(workspaceId, null);
    }
    updateSelectedUdid(effectiveUdid);
    // Runs on every workspace switch (workspaceId prop changes — always-mounted component).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

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
  const [inspectMode, setInspectMode] = useState(false);
  const [inspectorSnapshot, setInspectorSnapshot] = useState<InspectorSnapshot | null>(null);
  const [hoveredInspectorNode, setHoveredInspectorNode] = useState<InspectorNode | null>(null);
  const [selectedInspectorNode, setSelectedInspectorNode] = useState<InspectorNode | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectPrompt, setInspectPrompt] = useState("");

  useEffect(() => {
    setInspectMode(false);
    setInspectorSnapshot(null);
    setHoveredInspectorNode(null);
    setSelectedInspectorNode(null);
    setInspectError(null);
    setInspectPrompt("");
  }, [workspaceId]);

  // Listen for build log events streamed from backend via q:event.
  // Filter to only this workspace so concurrent builds don't interleave.
  useEffect(() => {
    if (state.phase !== "building") {
      setBuildLogs([]);
      return;
    }
    const cleanup = onEvent((event, data) => {
      if (event !== "sim:buildLog") return;
      const d = data as { workspaceId: string; line: string };
      if (d.workspaceId !== workspaceId) return;
      setBuildLogs((prev) => {
        const next = [...prev, d.line];
        return next.length > MAX_BUILD_LOG_LINES ? next.slice(-MAX_BUILD_LOG_LINES) : next;
      });
    });
    return cleanup;
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
  const noIosSimulators = iosSimulators.length === 0 && state.phase === "idle";

  // Device changes are safe while idle/streaming/running/error. They are blocked
  // during boot/build because the target simulator would be ambiguous.
  const selectorDisabled =
    noIosSimulators || state.phase === "booting" || state.phase === "building";
  const claimedUdids = useMemo(() => {
    const claimed = new Set<string>();
    for (const [wsId, phase] of Object.entries(simulatorSessions)) {
      if (wsId === workspaceId) continue;
      if ("udid" in phase && phase.udid) claimed.add(phase.udid);
    }
    return claimed;
  }, [simulatorSessions, workspaceId]);

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
  // The fast path is the store itself: when the backend is alive it pushes
  // sim:streamReady, and the MJPEG effect reconnects from the store's stream URL.
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

  const startSimulatorStream = async (udid: string, eventType: "BOOT" | "SWITCH_DEVICE") => {
    const ownerWsId = simulatorStoreActions.getWorkspaceByUdid(udid, workspaceId);
    if (ownerWsId) {
      if (state.phase === "idle") {
        simulatorStoreActions.setSession(workspaceId, {
          phase: "error",
          message: "That simulator is already in use by another workspace.",
          canRetry: false,
        });
      }
      return;
    }

    if (!simulatorStoreActions.dispatch(workspaceId, { type: eventType, udid })) return;

    // Skip the simctl boot check if the frontend already knows the device is booted
    // (saves 1-10s of `simctl list --json` parsing).
    const isBooted = iosSimulators.find((sim) => sim.udid === udid)?.state === "Booted";
    try {
      const stream = await simulatorService.startStreaming(workspaceId, udid, isBooted);
      if (!stream.hid_available) {
        console.warn("[Simulator] HID client not available — touch/scroll/key injection disabled");
      }
      // No gen guard: dispatch targets the originating workspace by workspaceId,
      // so the write is correct even if the user switched away mid-boot.
      simulatorStoreActions.dispatch(workspaceId, {
        type: "STREAM_READY",
        udid,
        stream,
      });
      workspaceLayoutActions.setSimulatorUdid(workspaceId, udid);
    } catch (e) {
      simulatorStoreActions.dispatch(workspaceId, {
        type: "ERROR",
        message: `Failed to boot simulator: ${getErrorMessage(e)}`,
        canRetry: true,
      });
    }
  };

  const handleStart = async () => {
    if (!selectedUdid) return;
    await startSimulatorStream(selectedUdid, "BOOT");
  };

  const handleSelectSimulator = (udid: string) => {
    if (udid === selectedUdidRef.current) return;
    if (simulatorStoreActions.getWorkspaceByUdid(udid, workspaceId)) return;

    updateSelectedUdid(udid);
    workspaceLayoutActions.setSimulatorUdid(workspaceId, udid);
    setInspectMode(false);
    setInspectorSnapshot(null);
    setHoveredInspectorNode(null);
    setSelectedInspectorNode(null);
    setInspectError(null);

    if (state.phase === "streaming" || state.phase === "running" || state.phase === "error") {
      void startSimulatorStream(udid, "SWITCH_DEVICE");
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
      const sid = workspaceLayoutActions.getLayout(workspaceId).activeChatTabSessionId;
      if (!sid) return;
      const bytes = await simulatorService.takeScreenshot(workspaceId);
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
      const file = new File([blob], `simulator-screenshot-${Date.now()}.png`, {
        type: "image/png",
      });
      const processed = await processImageFiles([file]);
      if (processed.length) sessionComposerActions.addImageAttachments(sid, processed);
    } catch (e) {
      console.error("Screenshot failed:", e);
    }
  }, [workspaceId]);

  const refreshInspectorSnapshot = useCallback(async () => {
    const snapshot = await simulatorService.inspectSnapshot(workspaceId);
    setInspectorSnapshot(snapshot);
    return snapshot;
  }, [workspaceId]);

  const handleToggleInspect = useCallback(async () => {
    if (inspectMode) {
      setInspectMode(false);
      setHoveredInspectorNode(null);
      setSelectedInspectorNode(null);
      setInspectError(null);
      return;
    }
    setInspectLoading(true);
    setInspectError(null);
    try {
      const snapshot = await simulatorService.startInspect(
        workspaceId,
        state.phase === "running" ? state.app.bundle_id : undefined
      );
      setInspectorSnapshot(snapshot);
      setInspectMode(true);
    } catch (err) {
      setInspectError(getErrorMessage(err));
      setInspectMode(false);
    } finally {
      setInspectLoading(false);
    }
  }, [inspectMode, state, workspaceId]);

  useEffect(() => {
    if (!inspectMode) return;
    const timer = setInterval(() => {
      refreshInspectorSnapshot().catch((err) => setInspectError(getErrorMessage(err)));
    }, 1000);
    return () => clearInterval(timer);
  }, [inspectMode, refreshInspectorSnapshot]);

  const handleInspectorSelect = useCallback((node: InspectorNode | null) => {
    setSelectedInspectorNode(node);
    if (node) setInspectPrompt(`Ask about ${node.label || node.className}`);
  }, []);

  const handleSendInspectToChat = useCallback(() => {
    const node = selectedInspectorNode;
    const sid = workspaceLayoutActions.getLayout(workspaceId).activeChatTabSessionId;
    if (!node || !sid) return;
    sessionComposerActions.addInspectedElement(sid, {
      ref: node.id,
      tagName: node.className,
      path: inspectorPathForNode(inspectorSnapshot, node),
      innerText: node.label || node.identifier || node.className,
      context: "external",
      props: inspectorPropsForNode(node),
      attributes: node.identifier ? `accessibilityIdentifier=${node.identifier}` : undefined,
    });
    sessionComposerActions.appendDraft(
      sid,
      inspectPrompt.trim() || `Help me understand this iOS view: ${node.className}`
    );
  }, [inspectPrompt, inspectorSnapshot, selectedInspectorNode, workspaceId]);

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

  // -------------------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------------------

  const isBuilding = state.phase === "building";
  const deviceHeader = (
    <SimulatorDeviceHeader
      state={state}
      selectedSim={selectedSim}
      isLive={isLive}
      inspectMode={inspectMode}
      inspectLoading={inspectLoading}
      onHome={handleHome}
      onScreenshot={handleScreenshot}
      onToggleInspect={handleToggleInspect}
    />
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="bg-bg-base flex h-full flex-col">
        <SimulatorContentHeader
          state={state}
          simulators={iosSimulators}
          selectedSim={selectedSim}
          selectedUdid={selectedUdid}
          selectorDisabled={selectorDisabled}
          claimedUdids={claimedUdids}
          isLive={isLive}
          hidAvailable={hidAvailable}
          hasProject={hasProject}
          onSelectSimulator={handleSelectSimulator}
          onBuildAndRun={handleBuildAndRun}
          onRetry={handleRetry}
          onStop={handleStop}
        />

        {noIosSimulators ? (
          <SimulatorEmptySurface
            icon={<Smartphone className="h-5 w-5" />}
            title="No iOS Simulators"
            description="Open Xcode and create a simulator to get started."
            action={
              <Button variant="outline" size="sm" onClick={loadSimulators}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Refresh
              </Button>
            }
          />
        ) : (
          <SimulatorStreamViewer
            workspaceId={workspaceId}
            streamUrl={streamUrl}
            isLive={isLive}
            hidAvailable={hidAvailable}
            onScreenshot={handleScreenshot}
            deviceType={selectedSim?.device_type}
            inspectMode={inspectMode}
            inspectorSnapshot={inspectorSnapshot}
            hoveredInspectorNodeId={hoveredInspectorNode?.id ?? null}
            selectedInspectorNodeId={selectedInspectorNode?.id ?? null}
            onInspectorHover={setHoveredInspectorNode}
            onInspectorSelect={handleInspectorSelect}
            deviceHeader={deviceHeader}
          >
            {inspectError && (
              <div className="border-destructive/30 bg-bg-base/95 text-destructive absolute top-3 left-1/2 z-30 max-w-[360px] -translate-x-1/2 rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur">
                {inspectError}
              </div>
            )}

            {inspectMode && selectedInspectorNode && (
              <InspectorDetailsPanel
                node={selectedInspectorNode}
                prompt={inspectPrompt}
                onPromptChange={setInspectPrompt}
                onClose={() => setSelectedInspectorNode(null)}
                onSendToChat={handleSendInspectToChat}
              />
            )}

            {/* Overlay states on top of (or instead of) the stream */}
            {match(state)
              .with({ phase: "idle" }, () => (
                <SimulatorLaunchPreview
                  phase="idle"
                  selectedSim={selectedSim}
                  selectedUdid={selectedUdid}
                  onStart={handleStart}
                  deviceHeader={deviceHeader}
                />
              ))
              .with({ phase: "booting" }, () => (
                <SimulatorLaunchPreview
                  phase="booting"
                  selectedSim={selectedSim}
                  selectedUdid={selectedUdid}
                  deviceHeader={deviceHeader}
                />
              ))
              .with({ phase: "error" }, (s) => (
                <SimulatorLaunchPreview
                  phase="error"
                  selectedSim={selectedSim}
                  selectedUdid={selectedUdid}
                  errorMessage={s.message}
                  canRetry={s.canRetry}
                  onRetry={handleRetry}
                  deviceHeader={deviceHeader}
                />
              ))
              .otherwise(() => null)}
          </SimulatorStreamViewer>
        )}

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
    </TooltipProvider>
  );
}

function InspectorDetailsPanel({
  node,
  prompt,
  onPromptChange,
  onClose,
  onSendToChat,
}: {
  node: InspectorNode;
  prompt: string;
  onPromptChange: (value: string) => void;
  onClose: () => void;
  onSendToChat: () => void;
}) {
  const rect = node.screenRect;
  const properties = Object.entries(node.properties ?? {}).slice(0, 8);

  return (
    <aside
      className="border-border bg-bg-base/95 absolute top-3 right-3 z-30 flex max-h-[calc(100%-24px)] w-[320px] flex-col overflow-hidden rounded-xl border shadow-2xl backdrop-blur"
      onMouseDown={(event) => event.stopPropagation()}
      onMouseMove={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <div className="border-border-subtle flex items-start gap-3 border-b p-3">
        <div className="bg-primary/10 text-primary flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
          <Crosshair className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-text-secondary truncate font-mono text-xs">{node.className}</p>
          <p className="text-text-muted mt-0.5 truncate text-xs">
            {node.label || node.identifier || "Native iOS view"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-text-muted hover:text-text-secondary rounded-md p-1 transition-colors"
          aria-label="Close inspector details"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {node.id.startsWith("ax-") && (
          <div className="bg-warning/10 text-warning mb-3 rounded-lg px-2 py-1.5 text-xs">
            Accessibility fallback — build/run an app for richer native properties.
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-bg-surface rounded-lg p-2">
            <p className="text-text-muted">Position</p>
            <p className="text-text-secondary mt-1 font-mono tabular-nums">
              {Math.round(rect.x)}, {Math.round(rect.y)}
            </p>
          </div>
          <div className="bg-bg-surface rounded-lg p-2">
            <p className="text-text-muted">Size</p>
            <p className="text-text-secondary mt-1 font-mono tabular-nums">
              {Math.round(rect.width)} × {Math.round(rect.height)}
            </p>
          </div>
        </div>

        {properties.length > 0 && (
          <div className="mt-3 space-y-1.5">
            <p className="text-text-muted text-xs font-medium">Properties</p>
            {properties.map(([key, value]) => (
              <div key={key} className="grid grid-cols-[110px_1fr] gap-2 text-xs">
                <span className="text-text-muted truncate font-mono">{key}</span>
                <span className="text-text-secondary truncate">{value}</span>
              </div>
            ))}
          </div>
        )}

        <label className="mt-4 block">
          <span className="text-text-muted text-xs font-medium">Ask about this view</span>
          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            className="border-border bg-bg-surface text-text-secondary placeholder:text-text-muted focus:border-primary/50 mt-1 min-h-20 w-full resize-none rounded-lg border px-2.5 py-2 text-xs outline-none"
            placeholder="Why is this clipped? Make this label red..."
          />
        </label>
      </div>

      <div className="border-border-subtle flex justify-end border-t p-2">
        <Button size="sm" onClick={onSendToChat} className="h-7 gap-1.5 px-2.5 text-xs">
          <Send className="h-3 w-3" />
          Add to Chat
        </Button>
      </div>
    </aside>
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
