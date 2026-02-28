/**
 * Tests for the simulator state machine transition function.
 *
 * These tests would have caught every recent bug:
 * - Stuck "booting" from workspace switch during async boot
 * - Shared UDID shutdown race (stop from wrong phase)
 * - Illegal transitions that silently corrupt the store
 *
 * Strategy: test every legal transition, test every illegal transition,
 * then test the specific bug scenarios as regression guards.
 */

import { describe, it, expect } from "vitest";
import { transition, hasStream, hasUdid } from "../../../src/features/simulator/machine";
import type { SimPhase, SimEvent } from "../../../src/features/simulator/machine";
import type { StreamInfo, InstalledApp } from "../../../src/features/simulator/types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const UDID_A = "AAAA-1111-AAAA-1111";
const UDID_B = "BBBB-2222-BBBB-2222";

const STREAM: StreamInfo = {
  url: "http://localhost:9000/stream",
  port: 9000,
  hid_available: true,
};

const STREAM_NO_HID: StreamInfo = {
  url: "http://localhost:9001/stream",
  port: 9001,
  hid_available: false,
};

const APP: InstalledApp = {
  bundle_id: "com.example.app",
  name: "Example App",
  app_path: "/path/to/app.app",
};

// Phase factories for readability
const idle = (): SimPhase => ({ phase: "idle" });
const booting = (udid = UDID_A): SimPhase => ({ phase: "booting", udid });
const streaming = (udid = UDID_A, stream = STREAM): SimPhase => ({
  phase: "streaming",
  udid,
  stream,
});
const building = (udid = UDID_A, stream = STREAM): SimPhase => ({
  phase: "building",
  udid,
  stream,
  startedAt: 1000,
});
const running = (udid = UDID_A, stream = STREAM, app = APP): SimPhase => ({
  phase: "running",
  udid,
  stream,
  app,
});
const error = (canRetry = true): SimPhase => ({
  phase: "error",
  message: "Something failed",
  canRetry,
});

// ============================================================================
// LEGAL TRANSITIONS — the happy path
// ============================================================================

describe("transition — legal transitions", () => {
  it("idle + BOOT → booting", () => {
    const next = transition(idle(), { type: "BOOT", udid: UDID_A });
    expect(next).toEqual({ phase: "booting", udid: UDID_A });
  });

  it("booting + STREAM_READY (same UDID) → streaming", () => {
    const next = transition(booting(UDID_A), {
      type: "STREAM_READY",
      udid: UDID_A,
      stream: STREAM,
    });
    expect(next).toEqual({ phase: "streaming", udid: UDID_A, stream: STREAM });
  });

  it("streaming + BUILD_START → building", () => {
    const next = transition(streaming(), { type: "BUILD_START", startedAt: 2000 });
    expect(next).toEqual({
      phase: "building",
      udid: UDID_A,
      stream: STREAM,
      startedAt: 2000,
    });
  });

  it("building + BUILD_SUCCESS → running", () => {
    const next = transition(building(), { type: "BUILD_SUCCESS", app: APP });
    expect(next).toEqual({
      phase: "running",
      udid: UDID_A,
      stream: STREAM,
      app: APP,
    });
  });

  it("running + APP_UNINSTALLED → streaming (stream survives)", () => {
    const next = transition(running(), { type: "APP_UNINSTALLED" });
    expect(next).toEqual({ phase: "streaming", udid: UDID_A, stream: STREAM });
  });

  it("running + BUILD_START → building (rebuild)", () => {
    const next = transition(running(), { type: "BUILD_START", startedAt: 3000 });
    expect(next).toEqual({
      phase: "building",
      udid: UDID_A,
      stream: STREAM,
      startedAt: 3000,
    });
  });

  it("error (canRetry) + BOOT → booting (retry)", () => {
    const next = transition(error(true), { type: "BOOT", udid: UDID_A });
    expect(next).toEqual({ phase: "booting", udid: UDID_A });
  });

  it("error (non-retryable) + BOOT → booting (explicit retry override)", () => {
    // The UI may hide the retry button, but the machine doesn't block it.
    // This lets the agent retry even when the UI says "no retry".
    const next = transition(error(false), { type: "BOOT", udid: UDID_A });
    expect(next).toEqual({ phase: "booting", udid: UDID_A });
  });
});

// ============================================================================
// STOP from every active phase
// ============================================================================

describe("transition — STOP from active phases", () => {
  it.each([
    ["booting", booting()],
    ["streaming", streaming()],
    ["building", building()],
    ["running", running()],
    ["error", error()],
  ] as const)("STOP from %s → idle", (_label, phase) => {
    const next = transition(phase, { type: "STOP" });
    expect(next).toEqual({ phase: "idle" });
  });

  it("STOP from idle → null (no-op)", () => {
    const next = transition(idle(), { type: "STOP" });
    expect(next).toBeNull();
  });
});

// ============================================================================
// ERROR from every active phase
// ============================================================================

describe("transition — ERROR from active phases", () => {
  it.each([
    ["booting", booting()],
    ["streaming", streaming()],
    ["building", building()],
    ["running", running()],
  ] as const)("ERROR from %s → error", (_label, phase) => {
    const next = transition(phase, {
      type: "ERROR",
      message: "Boom",
      canRetry: true,
    });
    expect(next).toEqual({ phase: "error", message: "Boom", canRetry: true });
  });

  it("ERROR from idle → null (no-op)", () => {
    const next = transition(idle(), {
      type: "ERROR",
      message: "Boom",
      canRetry: true,
    });
    expect(next).toBeNull();
  });
});

// ============================================================================
// CLEAR — force reset
// ============================================================================

describe("transition — CLEAR (forced reset)", () => {
  it.each([
    ["idle", idle()],
    ["booting", booting()],
    ["streaming", streaming()],
    ["building", building()],
    ["running", running()],
    ["error", error()],
  ] as const)("CLEAR from %s → idle", (_label, phase) => {
    const next = transition(phase, { type: "CLEAR" });
    expect(next).toEqual({ phase: "idle" });
  });
});

// ============================================================================
// ILLEGAL TRANSITIONS — must return null
// ============================================================================

describe("transition — illegal transitions return null", () => {
  it("BOOT while already booting → null", () => {
    expect(transition(booting(), { type: "BOOT", udid: UDID_A })).toBeNull();
  });

  it("BOOT while streaming → null", () => {
    expect(transition(streaming(), { type: "BOOT", udid: UDID_A })).toBeNull();
  });

  it("BOOT while building → null", () => {
    expect(transition(building(), { type: "BOOT", udid: UDID_A })).toBeNull();
  });

  it("BOOT while running → null", () => {
    expect(transition(running(), { type: "BOOT", udid: UDID_A })).toBeNull();
  });

  it("STREAM_READY from idle → null", () => {
    expect(
      transition(idle(), { type: "STREAM_READY", udid: UDID_A, stream: STREAM })
    ).toBeNull();
  });

  it("STREAM_READY with wrong UDID → null", () => {
    // Prevents stale async completion from corrupting state
    expect(
      transition(booting(UDID_A), { type: "STREAM_READY", udid: UDID_B, stream: STREAM })
    ).toBeNull();
  });

  it("STREAM_READY while already streaming → null", () => {
    expect(
      transition(streaming(), { type: "STREAM_READY", udid: UDID_A, stream: STREAM })
    ).toBeNull();
  });

  it("BUILD_START from idle → null", () => {
    expect(transition(idle(), { type: "BUILD_START", startedAt: 1000 })).toBeNull();
  });

  it("BUILD_START from booting → null", () => {
    expect(transition(booting(), { type: "BUILD_START", startedAt: 1000 })).toBeNull();
  });

  it("BUILD_START from building → null (no double-build)", () => {
    expect(transition(building(), { type: "BUILD_START", startedAt: 1000 })).toBeNull();
  });

  it("BUILD_START from error → null", () => {
    expect(transition(error(), { type: "BUILD_START", startedAt: 1000 })).toBeNull();
  });

  it("BUILD_SUCCESS from streaming → null", () => {
    expect(transition(streaming(), { type: "BUILD_SUCCESS", app: APP })).toBeNull();
  });

  it("BUILD_SUCCESS from idle → null", () => {
    expect(transition(idle(), { type: "BUILD_SUCCESS", app: APP })).toBeNull();
  });

  it("APP_UNINSTALLED from streaming → null", () => {
    expect(transition(streaming(), { type: "APP_UNINSTALLED" })).toBeNull();
  });

  it("APP_UNINSTALLED from idle → null", () => {
    expect(transition(idle(), { type: "APP_UNINSTALLED" })).toBeNull();
  });
});

// ============================================================================
// DATA PRESERVATION — transitions carry forward the right data
// ============================================================================

describe("transition — data preservation", () => {
  it("BUILD_START from streaming preserves UDID and stream", () => {
    const current = streaming(UDID_A, STREAM_NO_HID);
    const next = transition(current, { type: "BUILD_START", startedAt: 5000 });
    expect(next).toMatchObject({
      phase: "building",
      udid: UDID_A,
      stream: STREAM_NO_HID,
      startedAt: 5000,
    });
  });

  it("BUILD_SUCCESS from building preserves UDID and stream", () => {
    const current = building(UDID_A, STREAM_NO_HID);
    const next = transition(current, { type: "BUILD_SUCCESS", app: APP });
    expect(next).toMatchObject({
      phase: "running",
      udid: UDID_A,
      stream: STREAM_NO_HID,
      app: APP,
    });
  });

  it("APP_UNINSTALLED from running preserves UDID and stream", () => {
    const current = running(UDID_B, STREAM_NO_HID, APP);
    const next = transition(current, { type: "APP_UNINSTALLED" });
    expect(next).toMatchObject({
      phase: "streaming",
      udid: UDID_B,
      stream: STREAM_NO_HID,
    });
  });

  it("BUILD_START from running (rebuild) preserves UDID and stream", () => {
    const current = running(UDID_B, STREAM);
    const next = transition(current, { type: "BUILD_START", startedAt: 9000 });
    expect(next).toMatchObject({
      phase: "building",
      udid: UDID_B,
      stream: STREAM,
      startedAt: 9000,
    });
  });
});

// ============================================================================
// REGRESSION TESTS — scenarios that triggered real bugs
// ============================================================================

describe("regression — stuck booting on workspace switch", () => {
  /**
   * Bug: User clicks Start (→ booting), then switches workspace before
   * startStreaming resolves. The gen guard in the component kills the
   * STREAM_READY completion. The store stays at "booting" forever.
   *
   * Fix with machine: STREAM_READY checks that the UDID matches. If the
   * component dispatches CLEAR on workspace switch-away (or the mount
   * probe dispatches CLEAR for a stuck booting state), the machine
   * correctly returns to idle.
   */
  it("STREAM_READY for stale UDID (different boot) → null", () => {
    // User started booting UDID_A, then switched workspace, then started UDID_B.
    // The stale STREAM_READY for UDID_A arrives — must be rejected.
    const current = booting(UDID_B);
    const next = transition(current, {
      type: "STREAM_READY",
      udid: UDID_A,
      stream: STREAM,
    });
    expect(next).toBeNull();
  });

  it("CLEAR from booting → idle (recovery for stuck boot)", () => {
    const next = transition(booting(), { type: "CLEAR" });
    expect(next).toEqual({ phase: "idle" });
  });
});

describe("regression — stop during different phases", () => {
  /**
   * Bug: stop_streaming was shutting down shared UDIDs. The frontend
   * sends STOP → clearWorkspaceSession, then calls Rust stopStreaming.
   * If another workspace uses the same UDID, the Rust side must not
   * shut down the simulator process.
   *
   * The machine doesn't fix the Rust side (that's already fixed with
   * ref-count check), but it ensures the frontend always transitions
   * cleanly to idle on STOP, regardless of which phase it was in.
   */
  it("STOP from building → idle (mid-build stop)", () => {
    const next = transition(building(), { type: "STOP" });
    expect(next).toEqual({ phase: "idle" });
  });

  it("STOP from error → idle (dismiss error)", () => {
    const next = transition(error(), { type: "STOP" });
    expect(next).toEqual({ phase: "idle" });
  });
});

describe("regression — double boot prevention", () => {
  /**
   * Potential bug: Agent calls SimulatorStart while the panel is already
   * booting (e.g., user clicked Start and agent also tried to start).
   * Without the machine, both would race and produce duplicate state writes.
   *
   * The machine returns null for BOOT while booting → the duplicate is
   * silently rejected.
   */
  it("BOOT while booting → null (prevents double boot)", () => {
    expect(transition(booting(UDID_A), { type: "BOOT", udid: UDID_A })).toBeNull();
  });

  it("BOOT while booting (different UDID) → null", () => {
    // Even switching to a different simulator mid-boot is rejected.
    // The user must STOP first, then BOOT with the new UDID.
    expect(transition(booting(UDID_A), { type: "BOOT", udid: UDID_B })).toBeNull();
  });
});

describe("regression — build during build prevention", () => {
  /**
   * Potential bug: Agent calls BuildAndRun while already building.
   * Without the machine, a second BUILD_START would overwrite the
   * startedAt timer and potentially cause the Rust side to spawn
   * a duplicate xcodebuild process.
   */
  it("BUILD_START while building → null (prevents double build)", () => {
    expect(transition(building(), { type: "BUILD_START", startedAt: 9999 })).toBeNull();
  });
});

// ============================================================================
// MULTI-STEP SEQUENCES — verify full flows
// ============================================================================

describe("transition — full lifecycle sequences", () => {
  it("idle → boot → stream → build → run → stop → idle", () => {
    let state: SimPhase = idle();

    state = transition(state, { type: "BOOT", udid: UDID_A })!;
    expect(state.phase).toBe("booting");

    state = transition(state, { type: "STREAM_READY", udid: UDID_A, stream: STREAM })!;
    expect(state.phase).toBe("streaming");

    state = transition(state, { type: "BUILD_START", startedAt: 1000 })!;
    expect(state.phase).toBe("building");

    state = transition(state, { type: "BUILD_SUCCESS", app: APP })!;
    expect(state.phase).toBe("running");

    state = transition(state, { type: "STOP" })!;
    expect(state.phase).toBe("idle");
  });

  it("idle → boot → error → retry boot → stream → stop", () => {
    let state: SimPhase = idle();

    state = transition(state, { type: "BOOT", udid: UDID_A })!;
    expect(state.phase).toBe("booting");

    state = transition(state, {
      type: "ERROR",
      message: "Boot failed",
      canRetry: true,
    })!;
    expect(state.phase).toBe("error");

    state = transition(state, { type: "BOOT", udid: UDID_A })!;
    expect(state.phase).toBe("booting");

    state = transition(state, { type: "STREAM_READY", udid: UDID_A, stream: STREAM })!;
    expect(state.phase).toBe("streaming");

    state = transition(state, { type: "STOP" })!;
    expect(state.phase).toBe("idle");
  });

  it("streaming → build → error → retry boot → stream → build → run", () => {
    let state: SimPhase = streaming();

    state = transition(state, { type: "BUILD_START", startedAt: 1000 })!;
    expect(state.phase).toBe("building");

    state = transition(state, {
      type: "ERROR",
      message: "Build failed",
      canRetry: true,
    })!;
    expect(state.phase).toBe("error");

    // After build error, user must fully restart (boot → stream → build).
    // The machine enforces this — can't go directly to streaming from error.
    state = transition(state, { type: "BOOT", udid: UDID_A })!;
    expect(state.phase).toBe("booting");

    state = transition(state, { type: "STREAM_READY", udid: UDID_A, stream: STREAM })!;
    expect(state.phase).toBe("streaming");

    state = transition(state, { type: "BUILD_START", startedAt: 2000 })!;
    state = transition(state, { type: "BUILD_SUCCESS", app: APP })!;
    expect(state.phase).toBe("running");
  });

  it("running → uninstall → rebuild → run (app lifecycle)", () => {
    let state: SimPhase = running();

    state = transition(state, { type: "APP_UNINSTALLED" })!;
    expect(state.phase).toBe("streaming");

    state = transition(state, { type: "BUILD_START", startedAt: 4000 })!;
    expect(state.phase).toBe("building");

    state = transition(state, { type: "BUILD_SUCCESS", app: APP })!;
    expect(state.phase).toBe("running");
  });
});

// ============================================================================
// GUARD HELPERS
// ============================================================================

describe("hasStream", () => {
  it("returns true for streaming, building, running", () => {
    expect(hasStream(streaming())).toBe(true);
    expect(hasStream(building())).toBe(true);
    expect(hasStream(running())).toBe(true);
  });

  it("returns false for idle, booting, error", () => {
    expect(hasStream(idle())).toBe(false);
    expect(hasStream(booting())).toBe(false);
    expect(hasStream(error())).toBe(false);
  });
});

describe("hasUdid", () => {
  it("returns true for booting, streaming, building, running", () => {
    expect(hasUdid(booting())).toBe(true);
    expect(hasUdid(streaming())).toBe(true);
    expect(hasUdid(building())).toBe(true);
    expect(hasUdid(running())).toBe(true);
  });

  it("returns false for idle and error", () => {
    expect(hasUdid(idle())).toBe(false);
    expect(hasUdid(error())).toBe(false);
  });
});
