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
  Trash2,
  MoreHorizontal,
  AlertCircle,
  Camera,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/shared/lib/utils";
import { listen } from "@/platform/tauri";
import { simulatorService } from "../api/simulator.service";
import type { InstalledApp, SimulatorInfo, StreamInfo } from "../types";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type SimPhase =
  | { phase: "idle" }
  | { phase: "booting"; udid: string }
  | { phase: "streaming"; udid: string; stream: StreamInfo }
  | { phase: "building"; udid: string; stream: StreamInfo; startedAt: number }
  | { phase: "running"; udid: string; stream: StreamInfo; app: InstalledApp }
  | { phase: "error"; message: string; canRetry: boolean };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SimulatorPanelProps {
  workspaceId: string;
  workspacePath: string;
}

// ---------------------------------------------------------------------------
// macOS virtual keycodes — KeyboardEvent.code → CGKeyCode (u16)
// Full ANSI layout: letters, digits, punctuation, modifiers, arrows.
// Cmd/Ctrl combos are filtered out before lookup (stay with IDE).
// ---------------------------------------------------------------------------

const MAC_KEYCODES: Record<string, number> = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5,
  KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12,
  KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17,
  Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21,
  Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25,
  Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29,
  BracketRight: 30, KeyO: 31, KeyU: 32, BracketLeft: 33,
  KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38,
  Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42,
  Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47,
  Tab: 48, Space: 49, Backquote: 50, Backspace: 51,
  ShiftLeft: 56, CapsLock: 57, AltLeft: 58, ControlLeft: 59,
  ShiftRight: 60, AltRight: 61, ControlRight: 62,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
};

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
  if (sim.name.toLowerCase().includes("pool") || sim.name.toLowerCase().includes("radon"))
    score -= 5000;
  return score;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SimulatorPanel({ workspaceId: _workspaceId, workspacePath }: SimulatorPanelProps) {
  const [simulators, setSimulators] = useState<SimulatorInfo[]>([]);
  const [selectedUdid, setSelectedUdid] = useState<string | null>(null);
  const [state, setState] = useState<SimPhase>({ phase: "idle" });

  // Canvas renders MJPEG frames — the img element is kept offscreen to avoid
  // WebKit's page-level loading indicator (MJPEG connections never "complete").
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Build log accumulator — stores last N lines for the build drawer
  const [buildLogs, setBuildLogs] = useState<string[]>([]);
  const buildLogEndRef = useRef<HTMLDivElement>(null);

  // Viewport focus
  const viewportRef = useRef<HTMLDivElement>(null);

  // Track whether streaming is active for unmount cleanup.
  // Ref avoids stale closure — the cleanup effect reads current value on unmount.
  const isStreamingRef = useRef(false);

  // Keep streaming ref in sync for unmount cleanup
  useEffect(() => {
    isStreamingRef.current =
      state.phase !== "idle" && state.phase !== "error";
  }, [state.phase]);

  // Cleanup on unmount — stop the streaming pipeline (MJPEG server, ObjC bridge,
  // dispatch queues, Radon subprocess) when the panel is destroyed.
  // Without this, resources leak until the window closes.
  useEffect(() => {
    return () => {
      if (isStreamingRef.current) {
        simulatorService.stopStreaming().catch(() => {});
      }
    };
  }, []);

  // Listen for build log events streamed from Rust during xcodebuild.
  // Accumulates lines into an array instead of replacing a single string.
  useEffect(() => {
    if (state.phase !== "building") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBuildLogs([]);
      return;
    }
    let unlisten: (() => void) | null = null;
    listen<string>("sim:build-log", (event) => {
      setBuildLogs((prev) => {
        const next = [...prev, event.payload];
        return next.length > MAX_BUILD_LOG_LINES ? next.slice(-MAX_BUILD_LOG_LINES) : next;
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [state.phase]);

  // Auto-scroll build log to bottom when new lines arrive
  useEffect(() => {
    buildLogEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [buildLogs]);

  // Filter to iOS-capable simulators
  const iosSimulators = useMemo(
    () =>
      simulators
        .filter(
          (s) =>
            s.runtime.includes("iOS") ||
            s.device_type.includes("iPhone") ||
            s.device_type.includes("iPad"),
        )
        .sort((a, b) => scoreSimulator(b) - scoreSimulator(a)),
    [simulators],
  );

  const selectedSim = iosSimulators.find((s) => s.udid === selectedUdid);

  // Whether device select should be disabled (any active state)
  const selectDisabled = state.phase !== "idle";

  // Stream URL from state (available in streaming, building, running)
  const streamUrl = match(state)
    .with({ phase: "streaming" }, (s) => s.stream.url)
    .with({ phase: "building" }, (s) => s.stream.url)
    .with({ phase: "running" }, (s) => s.stream.url)
    .otherwise(() => null);

  // Whether HID (touch injection) is available
  const hidAvailable = match(state)
    .with({ phase: "streaming" }, (s) => s.stream.hid_available)
    .with({ phase: "building" }, (s) => s.stream.hid_available)
    .with({ phase: "running" }, (s) => s.stream.hid_available)
    .otherwise(() => true);

  // Whether the MJPEG stream is active
  const isLive = streamUrl !== null;

  // Draw MJPEG frames from an offscreen <img> onto the visible <canvas>.
  // The img is never added to the DOM, so WebKit won't show its loading
  // indicator. The canvas paints frames via requestAnimationFrame.
  useEffect(() => {
    if (!streamUrl) return;

    const img = new Image();
    img.src = streamUrl;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let prevW = 0;
    let prevH = 0;

    const draw = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w > 0 && h > 0) {
        // Resize canvas buffer when the stream resolution changes
        if (w !== prevW || h !== prevH) {
          canvas.width = w;
          canvas.height = h;
          prevW = w;
          prevH = h;
        }
        ctx.drawImage(img, 0, 0);
      }
      animId = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(animId);
      img.src = ""; // Disconnect the MJPEG stream
    };
  }, [streamUrl]);

  // Track whether we've already warned about touch failure (avoid console spam)
  const touchWarnedRef = useRef(false);

  // -------------------------------------------------------------------------
  // Load simulators on mount
  // -------------------------------------------------------------------------

  const loadSimulators = useCallback(async () => {
    try {
      const sims = await simulatorService.listSimulators();
      setSimulators(sims);
      if (!selectedUdid && sims.length > 0) {
        // Pick best default: booted iPhone > shutdown iPhone > booted iPad
        const scored = [...sims]
          .filter(
            (s) =>
              s.runtime.includes("iOS") ||
              s.device_type.includes("iPhone") ||
              s.device_type.includes("iPad"),
          )
          .sort((a, b) => scoreSimulator(b) - scoreSimulator(a));
        setSelectedUdid(scored[0]?.udid ?? sims[0].udid);
      }
    } catch (e) {
      setState({ phase: "error", message: `Failed to load simulators: ${e}`, canRetry: false });
    }
  }, [selectedUdid]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    loadSimulators();
  }, [loadSimulators]);

  // -------------------------------------------------------------------------
  // Start — boot simulator and begin streaming (no build)
  // -------------------------------------------------------------------------

  const handleStart = async () => {
    if (!selectedUdid) return;
    touchWarnedRef.current = false; // Reset touch warning for new session
    setState({ phase: "booting", udid: selectedUdid });
    try {
      const stream = await simulatorService.startStreaming(selectedUdid);
      if (!stream.hid_available) {
        console.warn("[Simulator] HID client not available — touch/scroll/key injection disabled");
      }
      setState({ phase: "streaming", udid: selectedUdid, stream });
    } catch (e) {
      setState({ phase: "error", message: `Failed to boot simulator: ${e}`, canRetry: true });
    }
  };

  // Build & Run — build project and launch on already-streaming simulator
  const handleBuildAndRun = async () => {
    const s = state;
    if (s.phase !== "streaming" && s.phase !== "running") return;
    setState({ phase: "building", udid: s.udid, stream: s.stream, startedAt: Date.now() });
    try {
      const app = await simulatorService.buildAndRun(workspacePath);
      setState({ phase: "running", udid: s.udid, stream: s.stream, app });
    } catch (e) {
      setState({ phase: "error", message: `Build failed: ${e}`, canRetry: true });
    }
  };

  // Stop everything and return to idle
  const handleStop = async () => {
    setState({ phase: "idle" });
    try {
      await simulatorService.stopStreaming();
    } catch (e) {
      console.error("Stop failed:", e);
    }
  };

  // Retry from error state — restarts the boot flow
  const handleRetry = () => {
    setState({ phase: "idle" });
    handleStart();
  };

  // Home button
  const handleHome = async () => {
    try {
      await simulatorService.pressHome();
    } catch (e) {
      console.error("Home button failed:", e);
    }
  };

  // App management
  const handleRelaunch = async () => {
    if (state.phase !== "running") return;
    try {
      await simulatorService.launchApp(state.app.bundle_id);
    } catch (e) {
      console.error("Relaunch failed:", e);
    }
  };

  const handleTerminate = async () => {
    if (state.phase !== "running") return;
    try {
      await simulatorService.terminateApp(state.app.bundle_id);
    } catch (e) {
      console.error("Terminate failed:", e);
    }
  };

  const handleUninstall = async () => {
    if (state.phase !== "running") return;
    const { udid, stream } = state;
    try {
      await simulatorService.uninstallApp(state.app.bundle_id);
      setState({ phase: "streaming", udid, stream });
    } catch (e) {
      console.error("Uninstall failed:", e);
    }
  };

  // -------------------------------------------------------------------------
  // Touch / scroll input forwarding
  //
  // The <canvas> uses max-h-full/max-w-full, so its element shrinks to the
  // stream's natural aspect ratio. getBoundingClientRect() returns the
  // actual rendered rect — no letterboxing mismatch.
  // -------------------------------------------------------------------------

  const lastCoordsRef = useRef<{ x: number; y: number } | null>(null);

  const getNormalizedCoords = useCallback(
    (e: React.MouseEvent | MouseEvent): { x: number; y: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const coords = {
        x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
      };
      lastCoordsRef.current = coords;
      return coords;
    },
    [],
  );

  // Log touch failure once, then suppress subsequent warnings
  const warnTouchFailed = useCallback((err: unknown) => {
    if (!touchWarnedRef.current) {
      touchWarnedRef.current = true;
      console.warn("[Simulator] Touch injection failed:", err);
    }
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!isLive) return;
      // Focus viewport for keyboard capture on click
      viewportRef.current?.focus();
      const coords = getNormalizedCoords(e);
      if (coords) simulatorService.sendTouch(coords.x, coords.y, "began").catch(warnTouchFailed);
    },
    [isLive, getNormalizedCoords, warnTouchFailed],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isLive || e.buttons !== 1) return;
      const coords = getNormalizedCoords(e);
      if (coords) simulatorService.sendTouch(coords.x, coords.y, "moved").catch(warnTouchFailed);
    },
    [isLive, getNormalizedCoords, warnTouchFailed],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (!isLive) return;
      const coords = getNormalizedCoords(e);
      if (coords) simulatorService.sendTouch(coords.x, coords.y, "ended").catch(warnTouchFailed);
    },
    [isLive, getNormalizedCoords, warnTouchFailed],
  );

  // Window-level mouseup — catches drag-release outside the image
  useEffect(() => {
    const onWindowMouseUp = () => {
      if (!isLive) return;
      const coords = lastCoordsRef.current;
      if (coords) {
        simulatorService.sendTouch(coords.x, coords.y, "ended").catch(warnTouchFailed);
        lastCoordsRef.current = null;
      }
    };
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => window.removeEventListener("mouseup", onWindowMouseUp);
  }, [isLive, warnTouchFailed]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!isLive) return;
      const coords = getNormalizedCoords(e as unknown as React.MouseEvent);
      if (!coords) return;
      e.preventDefault();
      simulatorService.sendScroll(coords.x, coords.y, -e.deltaX, -e.deltaY).catch(() => {});
    },
    [isLive, getNormalizedCoords],
  );

  // -------------------------------------------------------------------------
  // Screenshot — capture PNG, copy to clipboard (download as fallback)
  // -------------------------------------------------------------------------

  const handleScreenshot = useCallback(async () => {
    try {
      const bytes = await simulatorService.takeScreenshot();
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
      if (navigator.clipboard && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `simulator-${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error("Screenshot failed:", e);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Keyboard input forwarding — maps KeyboardEvent.code to macOS keycodes.
  // Cmd/Ctrl combos are NOT forwarded (stay with IDE). Escape blurs viewport.
  // -------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isLive || !hidAvailable) return;
      // Cmd/Ctrl combos stay with the IDE — only intercept Cmd+Shift+S for screenshot
      if (e.metaKey || e.ctrlKey) {
        if (e.shiftKey && e.code === "KeyS") {
          e.preventDefault();
          handleScreenshot();
        }
        return;
      }
      // Escape releases keyboard focus back to the IDE
      if (e.code === "Escape") {
        (e.target as HTMLElement).blur();
        return;
      }
      const keycode = MAC_KEYCODES[e.code];
      if (keycode !== undefined) {
        e.preventDefault();
        simulatorService.sendKey(keycode, "down").catch(() => {});
      }
    },
    [isLive, hidAvailable, handleScreenshot],
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isLive || !hidAvailable) return;
      if (e.metaKey || e.ctrlKey) return;
      const keycode = MAC_KEYCODES[e.code];
      if (keycode !== undefined) {
        e.preventDefault();
        simulatorService.sendKey(keycode, "up").catch(() => {});
      }
    },
    [isLive, hidAvailable],
  );

  // -------------------------------------------------------------------------
  // Empty state — no simulators installed
  // -------------------------------------------------------------------------

  if (iosSimulators.length === 0 && state.phase !== "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Smartphone className="h-8 w-8 text-text-muted" />
        <div>
          <p className="text-sm font-medium text-text-secondary">No iOS Simulators</p>
          <p className="mt-1 text-xs text-text-muted">
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
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
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

        {/* Device selector */}
        <Select
          value={selectedUdid ?? ""}
          onValueChange={setSelectedUdid}
          disabled={selectDisabled}
        >
          <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
            <SelectValue placeholder="Select simulator..." />
          </SelectTrigger>
          <SelectContent>
            {iosSimulators.map((sim) => (
              <SelectItem key={sim.udid} value={sim.udid}>
                <span className="flex items-center gap-1.5">
                  {sim.state === "Booted" && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                  )}
                  {sim.name}
                  <span className="ml-auto text-[10px] text-text-muted">
                    {sim.runtime.replace("com.apple.CoreSimulator.SimRuntime.", "")}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* No-touch warning — inline in toolbar when HID is unavailable */}
        {isLive && !hidAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1 text-warning">
                <AlertCircle className="h-3 w-3" />
                <span className="text-[10px]">No touch</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[220px]">
              <p className="text-xs">
                HID client not available. Touch, scroll, and keyboard input
                won't work. Check Xcode/Simulator.app installation.
              </p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Primary action — morphs based on state. Idle CTA is in the viewport, not here. */}
          {match(state)
            .with({ phase: "idle" }, () => null)
            .with({ phase: "booting" }, () => (
              <Button
                variant="outline"
                size="sm"
                disabled
                className="h-7 gap-1.5 px-2.5 text-xs"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Booting
              </Button>
            ))
            .with({ phase: "streaming" }, () => (
              <Button
                variant="outline"
                size="sm"
                onClick={handleBuildAndRun}
                className="h-7 gap-1.5 px-2.5 text-xs"
              >
                <Rocket className="h-3.5 w-3.5" />
                Build & Run
              </Button>
            ))
            .with({ phase: "building" }, () => (
              <Button
                variant="outline"
                size="sm"
                disabled
                className="h-7 gap-1.5 px-2.5 text-xs"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Building
              </Button>
            ))
            .with({ phase: "running" }, () => (
              <Button
                variant="outline"
                size="sm"
                onClick={handleBuildAndRun}
                className="h-7 gap-1.5 px-2.5 text-xs"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Rebuild
              </Button>
            ))
            .with({ phase: "error" }, (s) =>
              s.canRetry ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRetry}
                  className="h-7 gap-1.5 px-2.5 text-xs"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              ) : null,
            )
            .exhaustive()}

          {/* Stop button — visible in all active states */}
          {state.phase !== "idle" && state.phase !== "error" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleStop}
                  className="h-7 w-7 p-0"
                >
                  <Square className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Stop simulator</TooltipContent>
            </Tooltip>
          )}

          {/* Home button — visible when streaming */}
          {isLive && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleHome}
                  className="h-7 w-7 p-0"
                >
                  <Home className="h-3.5 w-3.5" />
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
                  <Camera className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Screenshot ⌘⇧S</TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
      </div>

      {/* ── Viewport ────────────────────────────────────────────── */}
      <div
        ref={viewportRef}
        tabIndex={isLive ? 0 : -1}
        className={cn(
          "relative flex flex-1 cursor-default items-center justify-center overflow-hidden bg-bg-base outline-none select-none",
          isLive && "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/30",
        )}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
      >
        {/* Live MJPEG stream rendered on <canvas> — the actual MJPEG <img>
         * is offscreen (never in the DOM) to avoid WebKit's persistent loading
         * indicator. Canvas uses max-h/max-w so getBoundingClientRect() returns
         * the rendered rect for correct touch coordinate normalization. */}
        {streamUrl && (
          <canvas
            ref={canvasRef}
            className="pointer-events-none max-h-full max-w-full select-none"
          />
        )}

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
                <p className="text-sm font-medium text-text-secondary">
                  {selectedSim?.name ?? "No simulator selected"}
                </p>
                {selectedSim && (
                  <p className="text-xs text-text-muted">
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
            </div>
          ))
          .with({ phase: "booting" }, () => (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-xs text-text-secondary">Booting simulator...</p>
            </div>
          ))
          .with({ phase: "error" }, (s) => (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
              <AlertCircle className="h-5 w-5 text-destructive/70" />
              <p className="max-w-[240px] text-center text-xs text-destructive">
                {s.message}
              </p>
              {s.canRetry && (
                <Button variant="outline" size="sm" onClick={handleRetry} className="h-7 text-xs">
                  <RotateCcw className="mr-1.5 h-3 w-3" />
                  Try Again
                </Button>
              )}
            </div>
          ))
          .otherwise(() => null)}
      </div>

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
        <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border-subtle px-3">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
          <span
            className="min-w-0 flex-1 truncate text-xs text-text-secondary"
            title={state.app.bundle_id}
          >
            {state.app.name}
          </span>

          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRelaunch}
                  className="h-6 w-6 p-0"
                >
                  <Rocket className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Relaunch</TooltipContent>
            </Tooltip>

            {/* Overflow menu for destructive actions */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                  <MoreHorizontal className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[140px]">
                <DropdownMenuItem onClick={handleTerminate}>
                  <Square className="mr-2 h-3.5 w-3.5" />
                  Terminate
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleUninstall}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Uninstall
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </TooltipProvider>
        </div>
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
        "flex shrink-0 flex-col border-t border-border-subtle",
        expanded && "max-h-[40%]",
      )}
    >
      {/* Shimmer bar — 2px progress indicator at the top edge of the drawer */}
      <div className="h-0.5 shrink-0 overflow-hidden">
        <div className="h-full w-1/3 bg-primary/80 animate-[build-shimmer_1.8s_cubic-bezier(.165,.84,.44,1)_infinite]" />
      </div>

      {/* Header strip — click to toggle log body. Shows latest line when collapsed. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex h-7 shrink-0 items-center gap-2 bg-bg-surface px-3 transition-colors duration-200 ease hover:bg-bg-surface/80"
      >
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warning" />
        <span className="text-xs font-medium text-text-secondary">Building</span>

        {/* Collapsed preview — truncated latest log line */}
        {!expanded && (
          <span className="min-w-0 flex-1 truncate px-2 text-left font-mono text-[10px] text-text-muted">
            {latestLine}
          </span>
        )}

        <span className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] tabular-nums text-text-muted">
            {formatted}
          </span>
          <ChevronDown
            className={cn(
              "h-3 w-3 text-text-muted transition-transform duration-200",
              expanded && "rotate-180",
            )}
          />
        </span>
      </button>

      {/* Scrollable log body — only visible when expanded */}
      {expanded && (
        <div className="flex-1 overflow-y-auto bg-bg-base px-3 py-2">
          {logs.length === 0 ? (
            <p className="font-mono text-[10px] leading-relaxed text-text-muted">
              Waiting for build output...
            </p>
          ) : (
            logs.map((line, i) => (
              <p
                key={i}
                className={cn(
                  "font-mono text-[10px] leading-relaxed",
                  i === logs.length - 1 ? "text-text-secondary" : "text-text-muted",
                  line.includes("error:") && "text-destructive",
                  line.includes("warning:") && "text-warning",
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
