// src/features/simulator/automation/useSimulatorRpcHandler.ts
// Handles simulator automation RPC requests from the sidecar.
//
// Architecture:
// Sidecar → Rust socket relay → "sidecar:request" Tauri event → this handler
// Handler calls existing Tauri IPC simulator commands → sends response back via socket
//
// This hook should be mounted in SimulatorPanel so it's active whenever
// the simulator is visible.

import { match } from "ts-pattern";
import { useEffect, useCallback, useRef } from "react";
import { invoke, listen, isTauriEnv } from "@/platform/tauri";
import { simulatorService } from "../api/simulator.service";
import type { SimulatorInfo, StreamInfo } from "../types";

interface SidecarRpcRequest {
  id: unknown;
  method: string;
  params: Record<string, unknown>;
}

/**
 * Callbacks from SimulatorPanel that let the RPC handler trigger
 * panel state transitions (e.g., boot a simulator and start streaming).
 * Follows the same pattern as useBrowserRpcHandler's getActiveTab/onAutoCreateTab.
 */
export interface SimulatorRpcCallbacks {
  /** Workspace ID for routing commands to the correct Rust session. */
  workspaceId: string;
  /** Boot a simulator by UDID and start streaming. Returns StreamInfo on success. */
  onBootSimulator: (udid: string) => Promise<StreamInfo | null>;
  /** Get the cached list of available simulators (null if not yet loaded). */
  getSimulators: () => SimulatorInfo[] | null;
}

/**
 * Listens for "sidecar:request" Tauri events with simulator method names,
 * dispatches to the appropriate simulator service call, and sends JSON-RPC
 * responses back to the sidecar.
 */
export function useSimulatorRpcHandler(callbacks: SimulatorRpcCallbacks) {
  // Store callbacks in refs for stable closures in the event listener
  const workspaceIdRef = useRef(callbacks.workspaceId);
  workspaceIdRef.current = callbacks.workspaceId;

  const onBootSimulatorRef = useRef(callbacks.onBootSimulator);
  onBootSimulatorRef.current = callbacks.onBootSimulator;

  const getSimulatorsRef = useRef(callbacks.getSimulators);
  getSimulatorsRef.current = callbacks.getSimulators;
  const sendResponse = useCallback(
    async (id: unknown, result: unknown) => {
      const response = JSON.stringify({
        jsonrpc: "2.0",
        result,
        id,
      });
      try {
        await invoke("send_sidecar_message", { message: response });
      } catch (err) {
        console.error("[SimulatorRPC] Failed to send response:", err);
      }
    },
    []
  );

  const sendError = useCallback(
    async (id: unknown, message: string) => {
      const response = JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message },
        id,
      });
      try {
        await invoke("send_sidecar_message", { message: response });
      } catch (err) {
        console.error("[SimulatorRPC] Failed to send error:", err);
      }
    },
    []
  );

  // -- Screenshot: capture JPEG from ObjC bridge, return as base64 -----------

  const handleSimScreenshot = useCallback(
    async (id: unknown, _params: Record<string, unknown>) => {
      // Pin workspaceId at handler entry to prevent cross-workspace leakage
      // if the ref changes between awaits.
      const workspaceId = workspaceIdRef.current;
      try {
        // sim_take_screenshot returns Vec<u8> (JPEG bytes as number[])
        const bytes = await simulatorService.takeScreenshot(workspaceId);
        const uint8 = new Uint8Array(bytes);

        // Convert to base64 — chunk to avoid stack overflow on large arrays
        let binary = "";
        const chunkSize = 8192;
        for (let i = 0; i < uint8.length; i += chunkSize) {
          binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);

        await sendResponse(id, { image: base64 });
      } catch (err: any) {
        await sendResponse(id, {
          image: "",
          error: err.message || "Screenshot failed",
        });
      }
    },
    [sendResponse]
  );

  // -- Tap: single touch began + ended at coordinates -----------------------

  const handleSimTap = useCallback(
    async (id: unknown, params: Record<string, unknown>) => {
      const workspaceId = workspaceIdRef.current;
      try {
        const x = params.x as number;
        const y = params.y as number;

        // Simulate a full tap: began → ended
        await simulatorService.sendTouch(workspaceId, x, y, "began");
        await simulatorService.sendTouch(workspaceId, x, y, "ended");

        await sendResponse(id, { success: true });
      } catch (err: any) {
        await sendResponse(id, { success: false, error: err.message || "Tap failed" });
      }
    },
    [sendResponse]
  );

  // -- Swipe: touch began → sequence of moved → ended ----------------------

  const handleSimSwipe = useCallback(
    async (id: unknown, params: Record<string, unknown>) => {
      const workspaceId = workspaceIdRef.current;
      try {
        const startX = params.startX as number;
        const startY = params.startY as number;
        const endX = params.endX as number;
        const endY = params.endY as number;
        const durationMs = (params.durationMs as number) || 300;

        // Interpolate touch points along the swipe path
        const steps = Math.max(10, Math.floor(durationMs / 16)); // ~60fps
        const stepDelay = durationMs / steps;

        await simulatorService.sendTouch(workspaceId, startX, startY, "began");

        for (let i = 1; i < steps; i++) {
          const t = i / steps;
          const x = startX + (endX - startX) * t;
          const y = startY + (endY - startY) * t;
          await simulatorService.sendTouch(workspaceId, x, y, "moved");
          await new Promise((r) => setTimeout(r, stepDelay));
        }

        await simulatorService.sendTouch(workspaceId, endX, endY, "ended");

        await sendResponse(id, { success: true });
      } catch (err: any) {
        await sendResponse(id, { success: false, error: err.message || "Swipe failed" });
      }
    },
    [sendResponse]
  );

  // -- Type text: send each character as a key press ------------------------

  const handleSimTypeText = useCallback(
    async (id: unknown, params: Record<string, unknown>) => {
      const workspaceId = workspaceIdRef.current;
      try {
        const text = params.text as string;

        // Map characters to USB HID usage codes and send them.
        // Collect unsupported chars so the agent knows what was dropped.
        const unsupported: string[] = [];
        for (const char of text) {
          const keycode = charToKeycode(char);
          if (keycode !== null) {
            const { code, shift } = keycode;
            // If shift is needed, press shift down first
            if (shift) {
              await simulatorService.sendKey(workspaceId, HID_LEFT_SHIFT, "down");
            }
            try {
              await simulatorService.sendKey(workspaceId, code, "down");
              await simulatorService.sendKey(workspaceId, code, "up");
            } finally {
              if (shift) {
                await simulatorService.sendKey(workspaceId, HID_LEFT_SHIFT, "up").catch(() => {});
              }
            }
            // Small delay between characters for reliability
            await new Promise((r) => setTimeout(r, 30));
          } else {
            unsupported.push(char);
          }
        }

        if (unsupported.length > 0) {
          await sendResponse(id, {
            success: true,
            error: `Unsupported characters skipped: ${[...new Set(unsupported)].join("")}`,
          });
        } else {
          await sendResponse(id, { success: true });
        }
      } catch (err: any) {
        await sendResponse(id, { success: false, error: err.message || "Type failed" });
      }
    },
    [sendResponse]
  );

  // -- Press key: single key down + up -------------------------------------

  const handleSimPressKey = useCallback(
    async (id: unknown, params: Record<string, unknown>) => {
      const workspaceId = workspaceIdRef.current;
      try {
        const keycode = params.keycode as number;
        const direction = params.direction as string | undefined;

        if (direction) {
          // Send only the specified direction
          await simulatorService.sendKey(workspaceId, keycode, direction);
        } else {
          // Full key press: down + up
          await simulatorService.sendKey(workspaceId, keycode, "down");
          await simulatorService.sendKey(workspaceId, keycode, "up");
        }

        await sendResponse(id, { success: true });
      } catch (err: any) {
        await sendResponse(id, {
          success: false,
          error: err.message || "Key press failed",
        });
      }
    },
    [sendResponse]
  );

  // -- Build & Run: xcodebuild + install + launch --------------------------

  const handleSimBuildAndRun = useCallback(
    async (id: unknown, params: Record<string, unknown>) => {
      const workspaceId = workspaceIdRef.current;
      try {
        const workspacePath = params.workspacePath as string;
        const app = await simulatorService.buildAndRun(workspaceId, workspacePath);

        await sendResponse(id, {
          success: true,
          bundleId: app.bundle_id,
          appName: app.name,
        });
      } catch (err: any) {
        await sendResponse(id, {
          success: false,
          error: err.message || "Build & run failed",
        });
      }
    },
    [sendResponse]
  );

  // -- List devices: return cached simulator list --------------------------

  const handleSimListDevices = useCallback(
    async (id: unknown, _params: Record<string, unknown>) => {
      try {
        const sims = getSimulatorsRef.current();
        if (!sims) {
          // Simulators not loaded yet — try fetching directly
          const fetched = await simulatorService.listSimulators();
          const devices = fetched.map((s) => ({
            name: s.name,
            udid: s.udid,
            state: s.state,
            runtime: s.runtime,
            deviceType: s.device_type,
            isAvailable: s.is_available,
          }));
          await sendResponse(id, { devices });
          return;
        }

        const devices = sims.map((s) => ({
          name: s.name,
          udid: s.udid,
          state: s.state,
          runtime: s.runtime,
          deviceType: s.device_type,
          isAvailable: s.is_available,
        }));
        await sendResponse(id, { devices });
      } catch (err: any) {
        await sendResponse(id, {
          devices: [],
          error: err.message || "Failed to list devices",
        });
      }
    },
    [sendResponse]
  );

  // -- Start simulator: boot + stream via panel callback ------------------

  const handleSimStart = useCallback(
    async (id: unknown, params: Record<string, unknown>) => {
      try {
        const udid = params.udid as string;
        if (!udid) {
          await sendResponse(id, {
            success: false,
            error: "Missing udid parameter. Use SimulatorListDevices to find available simulators.",
          });
          return;
        }

        const stream = await onBootSimulatorRef.current(udid);
        if (!stream) {
          await sendResponse(id, {
            success: false,
            error: "Failed to boot simulator. Check that the UDID is valid.",
          });
          return;
        }

        await sendResponse(id, {
          success: true,
          url: stream.url,
          port: stream.port,
          hidAvailable: stream.hid_available,
        });
      } catch (err: any) {
        await sendResponse(id, {
          success: false,
          error: err.message || "Failed to start simulator",
        });
      }
    },
    [sendResponse]
  );

  // -- Listen for sidecar:request events and dispatch ----------------------

  useEffect(() => {
    if (!isTauriEnv) return;

    const unlistenPromise = listen<SidecarRpcRequest>("sidecar:request", (event) => {
      const { id, method, params } = event.payload;
      if (import.meta.env.DEV) {
        console.log("[SimulatorRPC] Received request:", method);
      }

      match(method)
        .with("simListDevices", () => handleSimListDevices(id, params))
        .with("simStart", () => handleSimStart(id, params))
        .with("simScreenshot", () => handleSimScreenshot(id, params))
        .with("simTap", () => handleSimTap(id, params))
        .with("simSwipe", () => handleSimSwipe(id, params))
        .with("simTypeText", () => handleSimTypeText(id, params))
        .with("simPressKey", () => handleSimPressKey(id, params))
        .with("simBuildAndRun", () => handleSimBuildAndRun(id, params))
        .otherwise(() => {
          // Unknown "sim*" method → tell the sidecar it doesn't exist.
          // Non-sim methods are silently ignored (other handlers pick them up).
          if (method.startsWith("sim")) {
            sendError(id, `Unknown simulator method: ${method}`);
          }
        });
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [
    handleSimListDevices,
    handleSimStart,
    handleSimScreenshot,
    handleSimTap,
    handleSimSwipe,
    handleSimTypeText,
    handleSimPressKey,
    handleSimBuildAndRun,
    sendError,
  ]);
}

// ---------------------------------------------------------------------------
// Character → USB HID usage code mapping for SimulatorTypeText
// IndigoHIDMessageForKeyboardArbitrary expects USB HID keycodes, NOT macOS
// virtual keycodes. See USB HID Usage Tables §10 (Keyboard/Keypad Page 0x07).
// ---------------------------------------------------------------------------

/** USB HID usage code for Left Shift modifier key */
export const HID_LEFT_SHIFT = 0xe1; // 225

function charToKeycode(char: string): { code: number; shift: boolean } | null {
  const lower = char.toLowerCase();
  const isUpper = char !== lower && char.toUpperCase() === char;

  // USB HID usage codes (Usage Page 0x07)
  const CHAR_MAP: Record<string, number> = {
    a: 0x04, b: 0x05, c: 0x06, d: 0x07, e: 0x08, f: 0x09,
    g: 0x0a, h: 0x0b, i: 0x0c, j: 0x0d, k: 0x0e, l: 0x0f,
    m: 0x10, n: 0x11, o: 0x12, p: 0x13, q: 0x14, r: 0x15,
    s: 0x16, t: 0x17, u: 0x18, v: 0x19, w: 0x1a, x: 0x1b,
    y: 0x1c, z: 0x1d,
    "1": 0x1e, "2": 0x1f, "3": 0x20, "4": 0x21, "5": 0x22,
    "6": 0x23, "7": 0x24, "8": 0x25, "9": 0x26, "0": 0x27,
    "\n": 0x28, "\t": 0x2b, " ": 0x2c,
    "-": 0x2d, "=": 0x2e, "[": 0x2f, "]": 0x30, "\\": 0x31,
    ";": 0x33, "'": 0x34, "`": 0x35, ",": 0x36, ".": 0x37,
    "/": 0x38,
  };

  // Shifted characters (map to the base key's HID code)
  const SHIFT_CHAR_MAP: Record<string, number> = {
    "!": 0x1e, "@": 0x1f, "#": 0x20, $: 0x21, "%": 0x22,
    "^": 0x23, "&": 0x24, "*": 0x25, "(": 0x26, ")": 0x27,
    _: 0x2d, "+": 0x2e, "{": 0x2f, "}": 0x30, "|": 0x31,
    ":": 0x33, '"': 0x34, "~": 0x35, "<": 0x36, ">": 0x37,
    "?": 0x38,
  };

  if (SHIFT_CHAR_MAP[char] !== undefined) {
    return { code: SHIFT_CHAR_MAP[char], shift: true };
  }

  if (CHAR_MAP[lower] !== undefined) {
    return { code: CHAR_MAP[lower], shift: isUpper };
  }

  return null;
}
