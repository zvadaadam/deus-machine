import { describe, it, expect } from "vitest";
import {
  connectCloudSessionSocket,
  type WebSocketLike,
  type WebSocketLikeMessage,
} from "@/features/session/cloud/cloudSessionSocket";

/** A controllable stand-in for the DOM WebSocket, driven by the test. */
class MockWs implements WebSocketLike {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  private listeners: Record<string, ((e: WebSocketLikeMessage) => void)[]> = {};

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close", {});
  }
  addEventListener(type: string, listener: (e: WebSocketLikeMessage) => void) {
    (this.listeners[type] ||= []).push(listener);
  }
  private emit(type: string, event: WebSocketLikeMessage) {
    (this.listeners[type] ?? []).forEach((l) => l(event));
  }
  triggerOpen() {
    this.readyState = 1;
    this.emit("open", {});
  }
  triggerMessage(data: unknown) {
    this.emit("message", { data });
  }
}

describe("connectCloudSessionSocket", () => {
  it("builds the agnt ws URL with the provider id, API version and token, and wires frames", () => {
    const mock = new MockWs();
    let capturedUrl = "";
    const frames: Record<string, unknown>[] = [];
    let opened = false;

    const socket = connectCloudSessionSocket({
      baseUrl: "https://api.agnt",
      providerSessionId: "prov-1",
      token: "jwt.tok/en+",
      onFrame: (f) => frames.push(f),
      onOpen: () => {
        opened = true;
      },
      createWs: (url) => {
        capturedUrl = url;
        return mock;
      },
    });

    // http→ws, correct path, versioned, token url-encoded on the query string.
    expect(capturedUrl).toMatch(/^wss:\/\/api\.agnt\/sessions\/prov-1\/ws\?v=/);
    expect(capturedUrl).toContain(`token=${encodeURIComponent("jwt.tok/en+")}`);

    mock.triggerOpen();
    expect(opened).toBe(true);

    // "pong" keep-alive replies are dropped, not delivered as frames.
    mock.triggerMessage("pong");
    mock.triggerMessage(JSON.stringify({ type: "session.snapshot", state: { status: "ready" } }));
    mock.triggerMessage("not json{{"); // unparseable → swallowed, not thrown

    expect(frames).toEqual([{ type: "session.snapshot", state: { status: "ready" } }]);

    socket.close();
    expect(socket.isOpen()).toBe(false);
  });

  it("reports a session-scoped socket as open only after the socket opens", () => {
    const mock = new MockWs();
    const socket = connectCloudSessionSocket({
      baseUrl: "https://api.agnt",
      providerSessionId: "p",
      token: "t",
      onFrame: () => {},
      createWs: () => mock,
    });
    expect(socket.isOpen()).toBe(false);
    mock.triggerOpen();
    expect(socket.isOpen()).toBe(true);
    socket.close();
  });
});
