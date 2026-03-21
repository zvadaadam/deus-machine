// src/features/simulator/automation/useSimulatorRpcHandler.ts
// Handles simulator automation RPC requests from the agent-server.
//
// Architecture:
//   Agent-server → Backend → q:event tool:request → this handler
//   Handler calls existing IPC simulator commands → sends q:tool_response back via WS
//
// This hook should be mounted in SimulatorPanel so it's active whenever
// the simulator is visible.

import { match } from "ts-pattern";
import { useEffect, useCallback, useRef } from "react";
import { getErrorMessage } from "@shared/lib/errors";
import { simulatorService } from "../api/simulator.service";
import type { SimulatorInfo, StreamInfo } from "../types";
import { useWsToolRequest } from "@/shared/hooks/useWsToolRequest";

/**
 * Callbacks from SimulatorPanel that let the RPC handler trigger
 * panel state transitions (e.g., boot a simulator and start streaming).
 * Follows a ref-based callback pattern for stable identity across re-renders.
 */
export interface SimulatorRpcCallbacks {
  /** Workspace ID for routing commands to the correct native session. */
  workspaceId: string;
  /** Boot a simulator by UDID and start streaming. Returns StreamInfo on success. */
  onBootSimulator: (udid: string) => Promise<StreamInfo | null>;
  /** Get the cached list of available simulators (null if not yet loaded). */
  getSimulators: () => SimulatorInfo[] | null;
}

/** Response function for tool request handlers. */
type RespondFn = (result: unknown) => void;

/**
 * Listens for tool:request events via WebSocket with simulator method names,
 * dispatches to the appropriate simulator service call, and sends responses
 * back via q:tool_response.
 */
export function useSimulatorRpcHandler(callbacks: SimulatorRpcCallbacks) {
  // Store callbacks in refs for stable closures in the event listener
  const workspaceIdRef = useRef(callbacks.workspaceId);
  workspaceIdRef.current = callbacks.workspaceId;

  const onBootSimulatorRef = useRef(callbacks.onBootSimulator);
  onBootSimulatorRef.current = callbacks.onBootSimulator;

  const getSimulatorsRef = useRef(callbacks.getSimulators);
  getSimulatorsRef.current = callbacks.getSimulators;

  // Guard against rapid duplicate auto-create calls
  // (not needed now but kept for consistency with browser handler)

  // -- Screenshot: capture JPEG from ObjC bridge, return as base64 -----------

  const handleSimScreenshot = useCallback(
    async (_params: Record<string, unknown>, respond: RespondFn) => {
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

        respond({ image: base64 });
      } catch (err: unknown) {
        respond({
          image: "",
          error: getErrorMessage(err),
        });
      }
    },
    []
  );

  // -- Tap: single touch began + ended at coordinates -----------------------

  const handleSimTap = useCallback(async (params: Record<string, unknown>, respond: RespondFn) => {
    const workspaceId = workspaceIdRef.current;
    try {
      const x = params.x as number;
      const y = params.y as number;

      // Simulate a full tap: began → ended
      await simulatorService.sendTouch(workspaceId, x, y, "began");
      await simulatorService.sendTouch(workspaceId, x, y, "ended");

      respond({ success: true });
    } catch (err: unknown) {
      respond({ success: false, error: getErrorMessage(err) });
    }
  }, []);

  // -- Swipe: touch began → sequence of moved → ended ----------------------

  const handleSimSwipe = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
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

        respond({ success: true });
      } catch (err: unknown) {
        respond({ success: false, error: getErrorMessage(err) });
      }
    },
    []
  );

  // -- Type text: send each character as a key press ------------------------

  const handleSimTypeText = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
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
          respond({
            success: true,
            error: `Unsupported characters skipped: ${[...new Set(unsupported)].join("")}`,
          });
        } else {
          respond({ success: true });
        }
      } catch (err: unknown) {
        respond({ success: false, error: getErrorMessage(err) });
      }
    },
    []
  );

  // -- Press key: single key down + up -------------------------------------

  const handleSimPressKey = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
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

        respond({ success: true });
      } catch (err: unknown) {
        respond({
          success: false,
          error: getErrorMessage(err),
        });
      }
    },
    []
  );

  // -- Build & Run: xcodebuild + install + launch --------------------------

  const handleSimBuildAndRun = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const workspaceId = workspaceIdRef.current;
      try {
        const workspacePath = params.workspacePath as string;
        const app = await simulatorService.buildAndRun(workspaceId, workspacePath);

        respond({
          success: true,
          bundleId: app.bundle_id,
          appName: app.name,
        });
      } catch (err: unknown) {
        respond({
          success: false,
          error: getErrorMessage(err),
        });
      }
    },
    []
  );

  // -- List devices: return cached simulator list --------------------------

  const handleSimListDevices = useCallback(
    async (_params: Record<string, unknown>, respond: RespondFn) => {
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
          respond({ devices });
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
        respond({ devices });
      } catch (err: unknown) {
        respond({
          devices: [],
          error: getErrorMessage(err),
        });
      }
    },
    []
  );

  // -- Start simulator: boot + stream via panel callback ------------------

  const handleSimStart = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      try {
        const udid = params.udid as string;
        if (!udid) {
          respond({
            success: false,
            error: "Missing udid parameter. Use SimulatorListDevices to find available simulators.",
          });
          return;
        }

        const stream = await onBootSimulatorRef.current(udid);
        if (!stream) {
          respond({
            success: false,
            error: "Failed to boot simulator. Check that the UDID is valid.",
          });
          return;
        }

        respond({
          success: true,
          url: stream.url,
          port: stream.port,
          hidAvailable: stream.hid_available,
        });
      } catch (err: unknown) {
        respond({
          success: false,
          error: getErrorMessage(err),
        });
      }
    },
    []
  );

  // -- WS event listener (agent-server → backend → q:event tool:request) --

  useWsToolRequest((method, requestId, params, respond, _respondError) => {
    if (import.meta.env.DEV) {
      console.log("[SimulatorRPC] Received request (WS):", method, "requestId:", requestId);
    }

    match(method)
      .with("simListDevices", () => handleSimListDevices(params, respond))
      .with("simStart", () => handleSimStart(params, respond))
      .with("simScreenshot", () => handleSimScreenshot(params, respond))
      .with("simTap", () => handleSimTap(params, respond))
      .with("simSwipe", () => handleSimSwipe(params, respond))
      .with("simTypeText", () => handleSimTypeText(params, respond))
      .with("simPressKey", () => handleSimPressKey(params, respond))
      .with("simBuildAndRun", () => handleSimBuildAndRun(params, respond))
      .otherwise(() => {
        // Unknown "sim*" method → tell the agent-server it doesn't exist.
        // Non-sim methods are silently ignored (other handlers pick them up).
        if (method.startsWith("sim")) {
          respond({ success: false, error: `Unknown simulator method: ${method}` });
        }
      });
  });
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
    a: 0x04,
    b: 0x05,
    c: 0x06,
    d: 0x07,
    e: 0x08,
    f: 0x09,
    g: 0x0a,
    h: 0x0b,
    i: 0x0c,
    j: 0x0d,
    k: 0x0e,
    l: 0x0f,
    m: 0x10,
    n: 0x11,
    o: 0x12,
    p: 0x13,
    q: 0x14,
    r: 0x15,
    s: 0x16,
    t: 0x17,
    u: 0x18,
    v: 0x19,
    w: 0x1a,
    x: 0x1b,
    y: 0x1c,
    z: 0x1d,
    "1": 0x1e,
    "2": 0x1f,
    "3": 0x20,
    "4": 0x21,
    "5": 0x22,
    "6": 0x23,
    "7": 0x24,
    "8": 0x25,
    "9": 0x26,
    "0": 0x27,
    "\n": 0x28,
    "\t": 0x2b,
    " ": 0x2c,
    "-": 0x2d,
    "=": 0x2e,
    "[": 0x2f,
    "]": 0x30,
    "\\": 0x31,
    ";": 0x33,
    "'": 0x34,
    "`": 0x35,
    ",": 0x36,
    ".": 0x37,
    "/": 0x38,
  };

  // Shifted characters (map to the base key's HID code)
  const SHIFT_CHAR_MAP: Record<string, number> = {
    "!": 0x1e,
    "@": 0x1f,
    "#": 0x20,
    $: 0x21,
    "%": 0x22,
    "^": 0x23,
    "&": 0x24,
    "*": 0x25,
    "(": 0x26,
    ")": 0x27,
    _: 0x2d,
    "+": 0x2e,
    "{": 0x2f,
    "}": 0x30,
    "|": 0x31,
    ":": 0x33,
    '"': 0x34,
    "~": 0x35,
    "<": 0x36,
    ">": 0x37,
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
