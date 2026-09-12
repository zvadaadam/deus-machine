/**
 * Unit tests for `sendMutate`'s `q:mutate_result` resolution contract.
 *
 * The bug fix carries `status` and `details` through the WS transport:
 *   route-delegate → query-engine.handleMutate → q:mutate_result frame →
 *   sendMutate's resolved `MutateResult` → RepoService.add's structured throw.
 *
 * These tests pin the CLIENT-SIDE link: `sendMutate` must surface `status` and
 * `details` on the resolved `MutateResult` when the backend's `q:mutate_result`
 * frame carries them, and must leave them `undefined` when absent (older
 * servers, success path).
 *
 * Because `query-protocol-client.ts` is a stateful singleton, each test uses
 * `vi.isolateModules` to load a fresh module instance and stubs the global
 * `WebSocket` with a fake that the test can drive (open, deliver frames).
 */
import { describe, it, expect, vi } from "vitest";

// `vi.hoisted` so the hobisted mock factories can reference these.
const { backendConfigMock, authMock } = vi.hoisted(() => ({
  backendConfigMock: {
    resolveBackendEndpoints: vi.fn(),
    isRelayMode: vi.fn(),
  },
  authMock: {
    getStoredToken: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock("@/shared/config/backend.config", () => ({
  resolveBackendEndpoints: backendConfigMock.resolveBackendEndpoints,
  isRelayMode: backendConfigMock.isRelayMode,
}));

vi.mock("@/features/auth", () => ({
  getStoredToken: authMock.getStoredToken,
  signOut: authMock.signOut,
}));

/**
 * Minimal fake WebSocket: captures sent frames, lets the test drive `onopen`
 * and `onmessage` to simulate the server. `connect()` does NOT reject the
 * construction even before `onopen` is wired (it defers `onopen` to a microtask
 * so the client has a chance to install handlers).
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static CLOSING = 2;

  readyState = 1;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

async function loadFreshClient() {
  FakeWebSocket.instances = [];
  backendConfigMock.resolveBackendEndpoints.mockReset();
  backendConfigMock.isRelayMode.mockReset();
  authMock.getStoredToken.mockReset();
  authMock.signOut.mockReset();
  backendConfigMock.resolveBackendEndpoints.mockResolvedValue({
    wsUrl: "ws://fake/test",
    apiBase: "http://fake/test",
  });
  backendConfigMock.isRelayMode.mockReturnValue(false);
  // Install the fake WebSocket — `connect()` does `new WebSocket(url)` and
  // reads `WebSocket.OPEN`. `vi.stubGlobal` (re)installs it per test and
  // restores between tests.
  vi.stubGlobal("WebSocket", FakeWebSocket);

  // Fresh module per test so the singleton WS client state (ws, connected,
  // pendingMutations) doesn't leak across cases. `vi.resetModules` clears the
  // registry; the next `import()` re-evaluates the module. `vi.mock` modules
  // for the deps stay wired (their factories re-run with the same hoisted refs).
  vi.resetModules();
  return await import("@/platform/ws/query-protocol-client");
}

/** Drive the connect handshake: open → connected frame → connect() resolves. */
async function handshake(mod: Awaited<ReturnType<typeof loadFreshClient>>) {
  const connectPromise = mod.connect();
  await new Promise((r) => setTimeout(r, 0)); // let FakeWebSocket construct + fire onopen
  const ws = FakeWebSocket.instances[0]!;
  ws.onmessage!({ data: JSON.stringify({ type: "connected", connectionId: "conn-test" }) });
  await connectPromise;
  return ws;
}

/** Read the last sent `q:mutate` frame and return its parsed id. */
function lastMutateId(ws: FakeWebSocket): string {
  const frame = JSON.parse(ws.sent[ws.sent.length - 1]!);
  if (frame.type !== "q:mutate") {
    throw new Error(`expected q:mutate frame, got ${frame.type}`);
  }
  return frame.id as string;
}

describe("sendMutate — q:mutate_result surfacing", () => {
  it("surfaces `status` and `details` on the resolved MutateResult for a 409", async () => {
    const mod = await loadFreshClient();
    const ws = await handshake(mod);

    const existingRepo = { id: "repo-1", name: "repo", root_path: "/tmp/repo" };
    const mutatePromise = mod.sendMutate("addRepo", { root_path: "/tmp/repo" });
    await new Promise((r) => setTimeout(r, 0)); // let the q:mutate frame be sent
    const mutId = lastMutateId(ws);

    ws.onmessage!({
      data: JSON.stringify({
        type: "q:mutate_result",
        id: mutId,
        success: false,
        error: "Repository already exists",
        status: 409,
        details: existingRepo,
      }),
    });

    const result = await mutatePromise;
    expect(result).toEqual({
      success: false,
      data: undefined,
      error: "Repository already exists",
      status: 409,
      details: existingRepo,
    });
  });

  it("leaves `status` and `details` undefined when the frame omits them (older server)", async () => {
    const mod = await loadFreshClient();
    const ws = await handshake(mod);

    const mutatePromise = mod.sendMutate("addRepo", { root_path: "/tmp/repo" });
    await new Promise((r) => setTimeout(r, 0));
    const mutId = lastMutateId(ws);

    // Pre-fix frame shape: only success + error.
    ws.onmessage!({
      data: JSON.stringify({
        type: "q:mutate_result",
        id: mutId,
        success: false,
        error: "Repository already exists",
      }),
    });

    const result = await mutatePromise;
    expect(result.success).toBe(false);
    expect(result.error).toBe("Repository already exists");
    expect(result.status).toBeUndefined();
    expect(result.details).toBeUndefined();
  });

  it("surfaces `data` and resolves with success: true on a happy-path mutation", async () => {
    const mod = await loadFreshClient();
    const ws = await handshake(mod);

    const createdRepo = { id: "repo-new", name: "new", root_path: "/tmp/new" };
    const mutatePromise = mod.sendMutate<{ id: string; name: string; root_path: string }>(
      "addRepo",
      { root_path: "/tmp/new" }
    );
    await new Promise((r) => setTimeout(r, 0));
    const mutId = lastMutateId(ws);

    ws.onmessage!({
      data: JSON.stringify({
        type: "q:mutate_result",
        id: mutId,
        success: true,
        data: createdRepo,
      }),
    });

    const result = await mutatePromise;
    expect(result).toEqual({
      success: true,
      data: createdRepo,
      error: undefined,
      status: undefined,
      details: undefined,
    });
  });

  it("ignores a non-numeric `status` and surfaces only `error`/`details` (defensive)", async () => {
    const mod = await loadFreshClient();
    const ws = await handshake(mod);

    const mutatePromise = mod.sendMutate("addRepo", { root_path: "/tmp/repo" });
    await new Promise((r) => setTimeout(r, 0));
    const mutId = lastMutateId(ws);

    ws.onmessage!({
      data: JSON.stringify({
        type: "q:mutate_result",
        id: mutId,
        success: false,
        error: "Broken",
        status: "409", // a string slips in — must NOT be forwarded as-is
        details: { thing: true },
      }),
    });

    const result = await mutatePromise;
    expect(result.success).toBe(false);
    expect(result.error).toBe("Broken");
    expect(result.status).toBeUndefined(); // only numeric status is trusted
    expect(result.details).toEqual({ thing: true });
  });
});
