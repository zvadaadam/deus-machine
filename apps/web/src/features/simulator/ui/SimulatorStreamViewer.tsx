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
 *   1. Backend subscribes to sim-helper MJPEG HTTP, parses multipart frames
 *   2. Pushes frames via `q:event sim:frame { base64 }` to frontend
 *   3. This component renders WS-pushed frames instead of <img> MJPEG source
 *   4. Add frame rate/quality negotiation for bandwidth control
 *   5. Detect relay mode: if stream URL is not localhost, use WS frame path
 */

import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/shared/lib/utils";
import { simulatorService } from "../api/simulator.service";
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
  children?: React.ReactNode;
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
  children,
}: SimulatorStreamViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const touchWarnedRef = useRef(false);
  const lastCoordsRef = useRef<{ x: number; y: number } | null>(null);

  // Stable ref for workspaceId (window-level mouseup needs current value)
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

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

    let frameCount = 0;
    img.onload = () => {
      frameCount++;
      if (frameCount === 1) {
        console.log("[SimStream] First frame loaded:", img.naturalWidth, "x", img.naturalHeight);
      }
    };
    img.onerror = (e) => {
      console.error("[SimStream] Image load error:", e);
    };

    img.src = streamUrl;
    console.log("[SimStream] Connecting to MJPEG:", streamUrl);

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let prevW = 0;
    let prevH = 0;
    let loggedFirstDraw = false;

    const draw = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w > 0 && h > 0) {
        if (!loggedFirstDraw) {
          console.log("[SimStream] First canvas draw:", w, "x", h);
          loggedFirstDraw = true;
        }
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
      const coords = getNormalizedCoords(e);
      if (coords)
        simulatorService.sendTouch(workspaceId, coords.x, coords.y, "began").catch(warnTouchFailed);
    },
    [isLive, workspaceId, getNormalizedCoords, warnTouchFailed]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isLive || e.buttons !== 1) return;
      const coords = getNormalizedCoords(e);
      if (coords)
        simulatorService.sendTouch(workspaceId, coords.x, coords.y, "moved").catch(warnTouchFailed);
    },
    [isLive, workspaceId, getNormalizedCoords, warnTouchFailed]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (!isLive) return;
      const coords = getNormalizedCoords(e);
      if (coords) {
        simulatorService.sendTouch(workspaceId, coords.x, coords.y, "ended").catch(warnTouchFailed);
        lastCoordsRef.current = null;
      }
    },
    [isLive, workspaceId, getNormalizedCoords, warnTouchFailed]
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
      if (!isLive) return;
      const coords = getNormalizedCoords(e, false);
      if (!coords) return;
      e.preventDefault();
      simulatorService
        .sendScroll(workspaceId, coords.x, coords.y, -e.deltaX, -e.deltaY)
        .catch(() => {});
    },
    [isLive, workspaceId, getNormalizedCoords]
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
        isLive &&
          !deviceType &&
          "focus-visible:ring-primary/30 focus-visible:ring-1 focus-visible:ring-inset"
      )}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
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
        </DeviceFrame>
      )}
      {children}
    </div>
  );
}
