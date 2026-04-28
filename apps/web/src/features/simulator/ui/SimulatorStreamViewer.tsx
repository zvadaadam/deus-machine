/**
 * SimulatorStreamViewer — MJPEG canvas + touch/scroll/keyboard input forwarding.
 *
 * Renders the live simulator stream on a <canvas> and handles all HID input
 * injection (touch, scroll, keyboard). Extracted from SimulatorPanel to
 * encapsulate the rendering + input concern.
 *
 * MJPEG rendering: Frames loaded into an offscreen <img> (never in the DOM)
 * and painted onto a visible <canvas> via requestAnimationFrame. This avoids
 * WebKit's persistent loading indicator for never-completing HTTP connections.
 *
 * Touch coordinates: Mouse coords are normalized to [0, 1] relative to the
 * canvas's rendered bounding rect. The <canvas> uses max-h-full/max-w-full
 * so getBoundingClientRect() returns the actual rendered rect — no
 * letterboxing mismatch.
 *
 * TODO(relay-streaming): In web/relay mode the MJPEG URL is not directly
 * accessible (it's on the remote Mac). To support relay streaming:
 *   1. Backend subscribes to simbridge MJPEG HTTP, parses multipart frames
 *   2. Pushes frames via `q:event sim:frame { base64 }` to frontend
 *   3. This component renders WS-pushed frames instead of <img> MJPEG source
 *   4. Add frame rate/quality negotiation for bandwidth control
 *   5. Detect relay mode: if stream URL is not localhost, use WS frame path
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { cn } from "@/shared/lib/utils";
import { simulatorService } from "../api/simulator.service";
import type { InspectorNode, InspectorSnapshot } from "../types";
import { DeviceFrame } from "./DeviceFrame";

// ---------------------------------------------------------------------------
// USB HID usage codes — KeyboardEvent.code → HID keycode (u16)
// IndigoHIDMessageForKeyboardArbitrary expects USB HID keycodes (Usage Page
// 0x07), NOT macOS virtual keycodes. Full ANSI layout: letters, digits,
// punctuation, modifiers, arrows.
// Cmd/Ctrl combos are filtered out before lookup (stay with IDE).
// ---------------------------------------------------------------------------

const HID_KEYCODES: Record<string, number> = {
  // Letters (0x04–0x1D)
  KeyA: 0x04,
  KeyB: 0x05,
  KeyC: 0x06,
  KeyD: 0x07,
  KeyE: 0x08,
  KeyF: 0x09,
  KeyG: 0x0a,
  KeyH: 0x0b,
  KeyI: 0x0c,
  KeyJ: 0x0d,
  KeyK: 0x0e,
  KeyL: 0x0f,
  KeyM: 0x10,
  KeyN: 0x11,
  KeyO: 0x12,
  KeyP: 0x13,
  KeyQ: 0x14,
  KeyR: 0x15,
  KeyS: 0x16,
  KeyT: 0x17,
  KeyU: 0x18,
  KeyV: 0x19,
  KeyW: 0x1a,
  KeyX: 0x1b,
  KeyY: 0x1c,
  KeyZ: 0x1d,
  // Digits (0x1E–0x27)
  Digit1: 0x1e,
  Digit2: 0x1f,
  Digit3: 0x20,
  Digit4: 0x21,
  Digit5: 0x22,
  Digit6: 0x23,
  Digit7: 0x24,
  Digit8: 0x25,
  Digit9: 0x26,
  Digit0: 0x27,
  // Control keys
  Enter: 0x28,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  // Punctuation
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  // Modifiers
  CapsLock: 0x39,
  ShiftLeft: 0xe1,
  ShiftRight: 0xe5,
  ControlLeft: 0xe0,
  ControlRight: 0xe4,
  AltLeft: 0xe2,
  AltRight: 0xe6,
  // Arrow keys
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SimulatorStreamViewerProps {
  workspaceId: string;
  streamUrl: string | null;
  isLive: boolean;
  hidAvailable: boolean;
  onScreenshot: () => void;
  /** device_type from SimulatorInfo — drives device frame rendering */
  deviceType?: string | null;
  inspectMode?: boolean;
  inspectorSnapshot?: InspectorSnapshot | null;
  hoveredInspectorNodeId?: string | null;
  selectedInspectorNodeId?: string | null;
  onInspectorHover?: (node: InspectorNode | null) => void;
  onInspectorSelect?: (node: InspectorNode | null) => void;
  children?: React.ReactNode;
}

interface FlatInspectorNode {
  node: InspectorNode;
  depth: number;
  order: number;
  path: string[];
}

function flattenInspectorNodes(
  snapshot: InspectorSnapshot | null | undefined
): FlatInspectorNode[] {
  const out: FlatInspectorNode[] = [];
  let order = 0;
  const walk = (node: InspectorNode, depth: number, path: string[]) => {
    const nextPath = [...path, node.className];
    out.push({ node, depth, order: order++, path: nextPath });
    for (const child of node.children) walk(child, depth + 1, nextPath);
  };
  for (const root of snapshot?.roots ?? []) walk(root, 0, []);
  return out;
}

function snapshotBounds(
  snapshot: InspectorSnapshot | null | undefined
): { width: number; height: number } | null {
  const root = snapshot?.roots.find(
    (node) => node.screenRect.width > 0 && node.screenRect.height > 0
  );
  if (!root) return null;
  return { width: root.screenRect.width, height: root.screenRect.height };
}

function contains(node: InspectorNode, x: number, y: number): boolean {
  const rect = node.screenRect;
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height;
}

function pickNodeAtPoint(nodes: FlatInspectorNode[], x: number, y: number): InspectorNode | null {
  let best: FlatInspectorNode | null = null;
  for (const item of nodes) {
    const node = item.node;
    if (node.hidden || node.alpha < 0.01) continue;
    if (node.screenRect.width <= 1 || node.screenRect.height <= 1) continue;
    if (!contains(node, x, y)) continue;
    if (!best) {
      best = item;
      continue;
    }
    const area = node.screenRect.width * node.screenRect.height;
    const bestArea = best.node.screenRect.width * best.node.screenRect.height;
    if (area < bestArea || (area === bestArea && item.order > best.order)) best = item;
  }
  return best?.node ?? null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SimulatorStreamViewer({
  workspaceId,
  streamUrl,
  isLive,
  hidAvailable,
  onScreenshot,
  deviceType,
  inspectMode = false,
  inspectorSnapshot = null,
  hoveredInspectorNodeId = null,
  selectedInspectorNodeId = null,
  onInspectorHover,
  onInspectorSelect,
  children,
}: SimulatorStreamViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const touchWarnedRef = useRef(false);
  const lastCoordsRef = useRef<{ x: number; y: number } | null>(null);
  const inspectorNodes = useMemo(
    () => flattenInspectorNodes(inspectorSnapshot),
    [inspectorSnapshot]
  );
  const inspectorBounds = useMemo(() => snapshotBounds(inspectorSnapshot), [inspectorSnapshot]);
  const selectedInspectorNode = useMemo(
    () => inspectorNodes.find((item) => item.node.id === selectedInspectorNodeId)?.node ?? null,
    [inspectorNodes, selectedInspectorNodeId]
  );
  const hoveredInspectorNode = useMemo(
    () => inspectorNodes.find((item) => item.node.id === hoveredInspectorNodeId)?.node ?? null,
    [hoveredInspectorNodeId, inspectorNodes]
  );

  // Stable ref for workspaceId (window-level mouseup needs current value)
  const workspaceIdRef = useRef(workspaceId);
  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  // Reset touch warning when stream reconnects
  useEffect(() => {
    if (streamUrl) touchWarnedRef.current = false;
  }, [streamUrl]);

  // -------------------------------------------------------------------------
  // MJPEG canvas rendering
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!streamUrl) return;

    const img = new Image();
    img.crossOrigin = "anonymous"; // Allow cross-origin MJPEG loading
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
      // Clear canvas so workspace-switch doesn't flash the old stream's last frame
      const c = canvasRef.current;
      if (c) c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    };
  }, [streamUrl]);

  // -------------------------------------------------------------------------
  // Coordinate normalization
  // -------------------------------------------------------------------------

  const getNormalizedCoords = useCallback(
    (
      e: React.MouseEvent | React.WheelEvent | MouseEvent,
      updateLast = true
    ): { x: number; y: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const coords = {
        x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
      };
      if (updateLast) lastCoordsRef.current = coords;
      return coords;
    },
    []
  );

  const getInspectorNode = useCallback(
    (e: React.MouseEvent | MouseEvent): InspectorNode | null => {
      if (!inspectorBounds) return null;
      const coords = getNormalizedCoords(e, false);
      if (!coords) return null;
      return pickNodeAtPoint(
        inspectorNodes,
        coords.x * inspectorBounds.width,
        coords.y * inspectorBounds.height
      );
    },
    [getNormalizedCoords, inspectorBounds, inspectorNodes]
  );

  const warnTouchFailed = useCallback((err: unknown) => {
    if (!touchWarnedRef.current) {
      touchWarnedRef.current = true;
      console.warn("[Simulator] Touch injection failed:", err);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Mouse handlers (touch forwarding)
  // -------------------------------------------------------------------------

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!isLive) return;
      viewportRef.current?.focus();
      if (inspectMode) {
        e.preventDefault();
        onInspectorSelect?.(getInspectorNode(e));
        return;
      }
      const coords = getNormalizedCoords(e);
      if (coords)
        simulatorService.sendTouch(workspaceId, coords.x, coords.y, "began").catch(warnTouchFailed);
    },
    [
      getInspectorNode,
      getNormalizedCoords,
      inspectMode,
      isLive,
      onInspectorSelect,
      warnTouchFailed,
      workspaceId,
    ]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (inspectMode) {
        onInspectorHover?.(getInspectorNode(e));
        return;
      }
      if (!isLive || e.buttons !== 1) return;
      const coords = getNormalizedCoords(e);
      if (coords)
        simulatorService.sendTouch(workspaceId, coords.x, coords.y, "moved").catch(warnTouchFailed);
    },
    [
      getInspectorNode,
      getNormalizedCoords,
      inspectMode,
      isLive,
      onInspectorHover,
      warnTouchFailed,
      workspaceId,
    ]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (inspectMode) return;
      if (!isLive) return;
      const coords = getNormalizedCoords(e);
      if (coords) {
        simulatorService.sendTouch(workspaceId, coords.x, coords.y, "ended").catch(warnTouchFailed);
        lastCoordsRef.current = null;
      }
    },
    [getNormalizedCoords, inspectMode, isLive, warnTouchFailed, workspaceId]
  );

  // Window-level mouseup — catches drag-release outside the canvas
  useEffect(() => {
    const onWindowMouseUp = () => {
      if (!isLive) return;
      const coords = lastCoordsRef.current;
      if (coords) {
        simulatorService
          .sendTouch(workspaceIdRef.current, coords.x, coords.y, "ended")
          .catch(warnTouchFailed);
        lastCoordsRef.current = null;
      }
    };
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => window.removeEventListener("mouseup", onWindowMouseUp);
  }, [isLive, warnTouchFailed]);

  // -------------------------------------------------------------------------
  // Scroll (wheel) forwarding
  // -------------------------------------------------------------------------

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (inspectMode) return;
      if (!isLive) return;
      const coords = getNormalizedCoords(e, false);
      if (!coords) return;
      e.preventDefault();
      simulatorService
        .sendScroll(workspaceId, coords.x, coords.y, -e.deltaX, -e.deltaY)
        .catch(() => {});
    },
    [getNormalizedCoords, inspectMode, isLive, workspaceId]
  );

  // -------------------------------------------------------------------------
  // Keyboard input forwarding — maps KeyboardEvent.code to USB HID keycodes.
  // Cmd/Ctrl combos are NOT forwarded (stay with IDE). Escape blurs viewport.
  // -------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isLive || !hidAvailable) return;
      if (e.metaKey || e.ctrlKey) {
        if (e.shiftKey && e.code === "KeyS") {
          e.preventDefault();
          onScreenshot();
        }
        return;
      }
      if (e.code === "Escape") {
        (e.target as HTMLElement).blur();
        return;
      }
      const keycode = HID_KEYCODES[e.code];
      if (keycode !== undefined) {
        e.preventDefault();
        simulatorService.sendKey(workspaceId, keycode, "down").catch(() => {});
      }
    },
    [isLive, workspaceId, hidAvailable, onScreenshot]
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isLive || !hidAvailable) return;
      const keycode = HID_KEYCODES[e.code];
      if (keycode !== undefined) {
        e.preventDefault();
        simulatorService.sendKey(workspaceId, keycode, "up").catch(() => {});
      }
    },
    [isLive, workspaceId, hidAvailable]
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      ref={viewportRef}
      tabIndex={isLive ? 0 : -1}
      className={cn(
        "bg-bg-base relative flex flex-1 cursor-default items-center justify-center overflow-hidden outline-none select-none",
        inspectMode && "cursor-crosshair",
        isLive &&
          !deviceType &&
          "focus-visible:ring-primary/30 focus-visible:ring-1 focus-visible:ring-inset"
      )}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={(event) => {
        if (inspectMode) onInspectorHover?.(null);
        else handleMouseUp(event);
      }}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    >
      {streamUrl && (
        <DeviceFrame deviceType={deviceType}>
          <canvas
            ref={canvasRef}
            className="pointer-events-none absolute inset-0 block h-full w-full select-none"
          />
          {inspectMode && inspectorBounds && (
            <InspectorOverlay
              node={selectedInspectorNode ?? hoveredInspectorNode}
              bounds={inspectorBounds}
            />
          )}
        </DeviceFrame>
      )}
      {children}
    </div>
  );
}

function InspectorOverlay({
  node,
  bounds,
}: {
  node: InspectorNode | null;
  bounds: { width: number; height: number };
}) {
  if (!node) return null;
  const rect = node.screenRect;
  const style = {
    left: `${(rect.x / bounds.width) * 100}%`,
    top: `${(rect.y / bounds.height) * 100}%`,
    width: `${(rect.width / bounds.width) * 100}%`,
    height: `${(rect.height / bounds.height) * 100}%`,
  };
  const label = node.label || node.identifier || node.className;

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className="border-primary bg-primary/10 absolute rounded-[3px] border" style={style} />
      <div
        className="bg-bg-base/95 border-border text-text-secondary absolute z-10 max-w-[220px] rounded-md border px-2 py-1 text-xs shadow-lg backdrop-blur"
        style={{
          left: `min(calc(${style.left} + 6px), calc(100% - 230px))`,
          top: `min(calc(${style.top} + ${style.height} + 6px), calc(100% - 44px))`,
        }}
      >
        <div className="truncate font-mono text-[11px]">{node.className}</div>
        {label !== node.className && <div className="text-text-muted truncate">{label}</div>}
      </div>
    </div>
  );
}
