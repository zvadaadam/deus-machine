import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addConnection,
  closeAll,
  connectedDeviceIds,
  handleProtocolMessage,
} from "../../../src/services/ws.service";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  closeAll();
  vi.useRealTimers();
});

describe("relayed viewers", () => {
  it("stay while they probe, and are forgotten (not denied) once their probes stop", () => {
    const close = vi.fn();
    const id = addConnection({ send: vi.fn(), close }, "phone", true);
    // The viewer's runtime client pings every 30s through the tunnel.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(30_000);
      handleProtocolMessage(id, { type: "ping", id: `p${i}` });
    }
    expect(connectedDeviceIds().has("phone")).toBe(true);

    // A half-open phone: the relay never reports it gone, and it says nothing.
    vi.advanceTimersByTime(100_000);
    expect(connectedDeviceIds().has("phone")).toBe(false);
    // Closing a relayed viewer is a denial that revokes its grant: never for silence.
    expect(close).not.toHaveBeenCalled();
  });

  it("count any frame the viewer sends as a sign of life", () => {
    const close = vi.fn();
    const id = addConnection({ send: vi.fn(), close }, "tablet", true);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30_000);
      handleProtocolMessage(id, { type: "q:unsubscribe", id: "sub" });
    }
    expect(close).not.toHaveBeenCalled();
    expect(connectedDeviceIds().has("tablet")).toBe(true);
  });
});
