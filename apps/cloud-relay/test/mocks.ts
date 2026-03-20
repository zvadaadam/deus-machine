import { vi } from "vitest";

// ---- Mock WebSocket ----

export interface MockWebSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
  _tags: string[];
  _sentMessages: unknown[];
}

export function createMockWebSocket(tags: string[] = []): MockWebSocket {
  const ws: MockWebSocket = {
    readyState: 1, // OPEN
    _tags: tags,
    _sentMessages: [],
    send: vi.fn((data: string) => {
      ws._sentMessages.push(JSON.parse(data));
    }),
    close: vi.fn(),
  };
  return ws;
}

/** Parse all JSON messages sent via ws.send() */
export function getSentMessages(ws: MockWebSocket): unknown[] {
  return ws._sentMessages;
}

/** Get the last sent message */
export function getLastSent(ws: MockWebSocket): unknown {
  return ws._sentMessages[ws._sentMessages.length - 1];
}

// ---- Mock Durable Object Storage ----

export interface MockDOStorage {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string | string[]) => Promise<boolean>;
  list: <T = unknown>(opts?: { prefix?: string }) => Promise<Map<string, T>>;
  setAlarm: ReturnType<typeof vi.fn>;
  _data: Map<string, unknown>;
  _alarmTime: number | null;
}

export function createMockStorage(): MockDOStorage {
  const data = new Map<string, unknown>();

  const storage: MockDOStorage = {
    _data: data,
    _alarmTime: null,

    get: vi.fn(async <T>(key: string): Promise<T | undefined> => {
      return data.get(key) as T | undefined;
    }),

    put: vi.fn(async (key: string, value: unknown): Promise<void> => {
      data.set(key, value);
    }),

    delete: vi.fn(async (key: string | string[]): Promise<boolean> => {
      if (Array.isArray(key)) {
        for (const k of key) data.delete(k);
        return true;
      }
      return data.delete(key);
    }),

    list: vi.fn(async <T>(opts?: { prefix?: string }): Promise<Map<string, T>> => {
      const result = new Map<string, T>();
      for (const [key, value] of data) {
        if (!opts?.prefix || key.startsWith(opts.prefix)) {
          result.set(key, value as T);
        }
      }
      return result;
    }),

    setAlarm: vi.fn(async (time: number) => {
      storage._alarmTime = time;
    }),
  };

  return storage;
}

// ---- Mock Durable Object State (ctx) ----

export interface MockDOState {
  storage: MockDOStorage;
  getWebSockets: (tag: string) => MockWebSocket[];
  getTags: (ws: unknown) => string[];
  acceptWebSocket: (ws: unknown, tags: string[]) => void;
  _websockets: Map<MockWebSocket, string[]>;
}

export function createMockState(): MockDOState {
  const storage = createMockStorage();
  const websockets = new Map<MockWebSocket, string[]>();

  const state: MockDOState = {
    storage,
    _websockets: websockets,

    getWebSockets: (tag: string): MockWebSocket[] => {
      const result: MockWebSocket[] = [];
      for (const [ws, tags] of websockets) {
        if (tags.includes(tag)) result.push(ws);
      }
      return result;
    },

    // In Cloudflare, getTags reads from the WebSocket object itself,
    // not the registry. Tags survive close/removal from the registry.
    getTags: (ws: unknown): string[] => {
      const mockWs = ws as MockWebSocket;
      return mockWs._tags || websockets.get(mockWs) || [];
    },

    acceptWebSocket: (ws: unknown, tags: string[]) => {
      const mockWs = ws as MockWebSocket;
      mockWs._tags = tags;
      websockets.set(mockWs, tags);
    },
  };

  return state;
}

// ---- RelayDO Test Harness ----
// Instantiates RelayDO with mocked ctx, bypassing the Cloudflare runtime.

export async function createTestDO() {
  // Mock cloudflare:workers before importing RelayDO
  vi.doMock("cloudflare:workers", () => ({
    DurableObject: class {
      ctx: unknown;
      env: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  }));

  const { RelayDO } = await import("../src/relay-do");
  const state = createMockState();
  const env = { RELAY: {}, ENVIRONMENT: "test" };
  const relay = new RelayDO(state as any, env);

  return { relay, state, storage: state.storage };
}

// ---- Helper: Register a server tunnel ----

export async function registerServer(
  relay: any,
  state: MockDOState,
  opts: { serverId?: string; relayToken?: string; serverName?: string } = {}
) {
  const { serverId = "test1234", relayToken = "tok_test", serverName = "Test Server" } = opts;

  // Simulate tunnel WebSocket upgrade
  const tunnelWs = createMockWebSocket(["tunnel"]);
  state._websockets.set(tunnelWs, ["tunnel"]);

  // Process register message
  await relay.webSocketMessage(
    tunnelWs,
    JSON.stringify({ type: "register", serverId, relayToken, serverName })
  );

  return tunnelWs;
}

// ---- Helper: Connect and authenticate a client ----

export async function connectAndAuthClient(
  relay: any,
  state: MockDOState,
  opts: { clientId?: string; deviceToken?: string } = {}
) {
  const { clientId = crypto.randomUUID(), deviceToken = "dev_tok_test" } = opts;

  // Simulate client WebSocket
  const clientWs = createMockWebSocket(["client", clientId]);
  state._websockets.set(clientWs, ["client", clientId]);
  await state.storage.put(`pending:${clientId}`, Date.now() + 5000);

  // Send auth message
  await relay.webSocketMessage(
    clientWs,
    JSON.stringify({ type: "authenticate", token: deviceToken })
  );

  return { clientWs, clientId };
}
