import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/shared/config/backend.config", () => ({
  resolveBackendEndpoints: async () => ({ wsUrl: "ws://backend.test/ws" }),
  isRelayMode: () => false,
}));
vi.mock("@/features/auth/hooks/useAuth", () => ({ getStoredToken: () => null, signOut: vi.fn() }));

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  serverSays(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
vi.stubGlobal("WebSocket", FakeWebSocket);

const { connect, sendRequest } = await import("@/platform/ws/query-protocol-client");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

it("a request made while the socket is still opening waits for it instead of failing", async () => {
  void connect();
  const request = sendRequest<{ theme: string }>("settings");
  await settle();

  const socket = FakeWebSocket.instances[0];
  expect(socket.sent).toEqual([]);
  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen?.();
  socket.serverSays({ type: "connected", connectionId: "c1" });
  await settle();

  const frame = socket.sent.find((f) => f.type === "q:request");
  expect(frame).toMatchObject({ resource: "settings" });
  socket.serverSays({ type: "q:response", id: frame!.id, data: { theme: "dark" } });
  await expect(request).resolves.toEqual({ theme: "dark" });
});
