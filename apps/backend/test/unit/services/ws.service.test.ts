import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addConnection,
  closeAll,
  closeAssistantConnections,
  connectedDeviceIds,
  FrameTooLarge,
  getConnection,
  handleProtocolMessage,
  sendFrame,
} from "../../../src/services/ws.service";
import { ASSISTANT_HOST } from "../../helpers";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  closeAll();
  vi.useRealTimers();
});

describe("sending frames", () => {
  it("reports a transport refusal and leaves other frames and local sockets alone", () => {
    const frame = { type: "q:response", id: "answer", data: "ok" } as const;
    const send = vi.fn().mockImplementationOnce(() => {
      throw new FrameTooLarge(300);
    });
    const virtual = addConnection({ send, close: vi.fn() }, "phone", true);
    expect(sendFrame(virtual, frame)).toBe("too-large");
    expect(send).toHaveBeenCalledOnce();
    expect(sendFrame(virtual, frame)).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(JSON.stringify(frame));

    const local = vi.fn();
    const localId = addConnection({ send: local, close: vi.fn() }, null);
    const large = { ...frame, data: "x".repeat(32 * 1024 * 1024) };
    expect(sendFrame(localId, large)).toBe("sent");
    expect(local).toHaveBeenCalledOnce();
    expect(JSON.parse(local.mock.calls[0][0]).data.length).toBe(large.data.length);
    expect(sendFrame("gone", frame)).toBe("unavailable");
  });
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

describe("assistant connections", () => {
  const admitted = (clientId: string, signInEndsAt = Infinity) => ({
    assistant: { clientId, access: "operate" as const, host: ASSISTANT_HOST },
    signInEndsAt,
  });
  const claude = admitted("claude");

  it("are not paired devices, and outlast a held request but not 200 seconds, pings or not", () => {
    const close = vi.fn();
    const id = addConnection({ send: vi.fn(), close }, null, true, claude);
    expect(connectedDeviceIds().size).toBe(0);
    // Deus Cloud holds one call up to about 150s; the connection may say nothing meanwhile.
    vi.advanceTimersByTime(150_000);
    expect(getConnection(id)).toBeDefined();
    for (let i = 0; i < 5; i++) {
      handleProtocolMessage(id, { type: "ping", id: `p${i}` });
      vi.advanceTimersByTime(10_000);
    }
    expect(getConnection(id)).toBeUndefined();
    expect(close).toHaveBeenCalledWith(4001, "Assistant connection ended");
  });

  it("end when their sign-in does, however much they ping", () => {
    const close = vi.fn();
    const id = addConnection(
      { send: vi.fn(), close },
      null,
      true,
      admitted("claude", Date.now() + 40_000)
    );
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(13_000);
      handleProtocolMessage(id, { type: "ping", id: `p${i}` });
    }
    expect(getConnection(id)).toBeDefined();
    vi.advanceTimersByTime(1_000);
    expect(getConnection(id)).toBeUndefined();
    expect(close).toHaveBeenCalledWith(4001, "Assistant sign-in expired");
  });

  it("end at once when admitted with a sign-in already past its end", () => {
    const id = addConnection(
      { send: vi.fn(), close: vi.fn() },
      null,
      true,
      admitted("claude", Date.now() - 1)
    );
    vi.advanceTimersByTime(0);
    expect(getConnection(id)).toBeUndefined();
  });

  it("close by client id, leaving every other connection", () => {
    const close = vi.fn();
    const id = addConnection({ send: vi.fn(), close }, null, true, claude);
    const other = addConnection({ send: vi.fn(), close: vi.fn() }, null, true, admitted("grok"));
    const phone = addConnection({ send: vi.fn(), close: vi.fn() }, "phone", true);
    closeAssistantConnections("claude");
    expect(getConnection(id)).toBeUndefined();
    expect(close).toHaveBeenCalledWith(4001, "Assistant access changed");
    expect(getConnection(other)).toBeDefined();
    expect(getConnection(phone)).toBeDefined();
  });
});
