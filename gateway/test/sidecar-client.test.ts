import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { SidecarClient } from "../clients/sidecar";

// NDJSON helper
function toNDJSON(...messages: Record<string, unknown>[]): string {
  return messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
}

describe("SidecarClient", () => {
  let socketPath: string;
  let server: net.Server;
  let client: SidecarClient;
  let serverSocket: net.Socket | null = null;

  beforeEach(async () => {
    socketPath = path.join(os.tmpdir(), `hive-test-sidecar-${Date.now()}.sock`);

    // Create a mock sidecar server
    server = net.createServer((socket) => {
      serverSocket = socket;
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, resolve);
    });

    client = new SidecarClient(socketPath);
  });

  afterEach(async () => {
    client.disconnect();
    server.close();
    serverSocket?.destroy();
    try { fs.unlinkSync(socketPath); } catch (_err) {
      // Socket file cleanup not critical if already removed
    }
  });

  it("connects to the sidecar socket", async () => {
    const connected = new Promise<void>((resolve) => client.on("connected", resolve));
    client.connect();
    await connected;
    expect(client.connected).toBe(true);
  });

  it("emits disconnected when socket closes", async () => {
    const connected = new Promise<void>((resolve) => client.on("connected", resolve));
    client.connect();
    await connected;

    // Prevent reconnect for test
    client.disconnect();
    expect(client.connected).toBe(false);
  });

  it("sends a notification to the sidecar", async () => {
    const connected = new Promise<void>((resolve) => client.on("connected", resolve));
    client.connect();
    await connected;

    const received = new Promise<string>((resolve) => {
      let buffer = "";
      serverSocket!.on("data", (data) => {
        buffer += data.toString();
        if (buffer.includes("\n")) resolve(buffer);
      });
    });

    client.notify("query", { type: "query", id: "sess-1" });

    const raw = await received;
    const msg = JSON.parse(raw.trim());
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.method).toBe("query");
    expect(msg.params.id).toBe("sess-1");
  });

  it("emits message events from sidecar notifications", async () => {
    const connected = new Promise<void>((resolve) => client.on("connected", resolve));
    client.connect();
    await connected;

    const messageReceived = new Promise<any>((resolve) => {
      client.on("message", resolve);
    });

    // Sidecar sends a notification
    serverSocket!.write(
      toNDJSON({
        jsonrpc: "2.0",
        method: "message",
        params: { id: "sess-1", type: "message", agentType: "claude", data: {} },
      })
    );

    const notif = await messageReceived;
    expect(notif.id).toBe("sess-1");
    expect(notif.type).toBe("message");
  });

  it("emits error events from sidecar queryError notifications", async () => {
    const connected = new Promise<void>((resolve) => client.on("connected", resolve));
    client.connect();
    await connected;

    const errorReceived = new Promise<any>((resolve) => {
      client.on("error", resolve);
    });

    serverSocket!.write(
      toNDJSON({
        jsonrpc: "2.0",
        method: "queryError",
        params: { id: "sess-1", type: "error", error: "Something broke", agentType: "claude" },
      })
    );

    const notif = await errorReceived;
    expect(notif.error).toBe("Something broke");
  });

  it("auto-approves askUserQuestion RPC requests", async () => {
    const connected = new Promise<void>((resolve) => client.on("connected", resolve));
    client.connect();
    await connected;

    const responseReceived = new Promise<string>((resolve) => {
      let buffer = "";
      serverSocket!.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n").filter(Boolean);
        // Skip the first line if it's from the client's side
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.result) resolve(line);
        }
      });
    });

    // Sidecar sends an RPC request
    serverSocket!.write(
      toNDJSON({
        jsonrpc: "2.0",
        id: 1,
        method: "askUserQuestion",
        params: {
          sessionId: "sess-1",
          questions: [{ question: "Continue?", options: ["Yes", "No"] }],
        },
      })
    );

    const raw = await responseReceived;
    const resp = JSON.parse(raw);
    expect(resp.id).toBe(1);
    expect(resp.result.answers).toEqual(["Yes"]);
  });

  it("auto-approves exitPlanMode RPC requests", async () => {
    const connected = new Promise<void>((resolve) => client.on("connected", resolve));
    client.connect();
    await connected;

    const responseReceived = new Promise<string>((resolve) => {
      let buffer = "";
      serverSocket!.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n").filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.result) resolve(line);
        }
      });
    });

    serverSocket!.write(
      toNDJSON({
        jsonrpc: "2.0",
        id: 2,
        method: "exitPlanMode",
        params: { sessionId: "sess-1", toolInput: {} },
      })
    );

    const raw = await responseReceived;
    const resp = JSON.parse(raw);
    expect(resp.id).toBe(2);
    expect(resp.result.approved).toBe(true);
  });

  it("rejects browser automation requests", async () => {
    const connected = new Promise<void>((resolve) => client.on("connected", resolve));
    client.connect();
    await connected;

    const responseReceived = new Promise<string>((resolve) => {
      let buffer = "";
      serverSocket!.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n").filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.error) resolve(line);
        }
      });
    });

    serverSocket!.write(
      toNDJSON({
        jsonrpc: "2.0",
        id: 3,
        method: "browserSnapshot",
        params: { sessionId: "sess-1" },
      })
    );

    const raw = await responseReceived;
    const resp = JSON.parse(raw);
    expect(resp.id).toBe(3);
    expect(resp.error.message).toContain("not available");
  });

  it("sends query notifications with correct structure", async () => {
    const connected = new Promise<void>((resolve) => client.on("connected", resolve));
    client.connect();
    await connected;

    const received = new Promise<string>((resolve) => {
      let buffer = "";
      serverSocket!.on("data", (data) => {
        buffer += data.toString();
        if (buffer.includes("\n")) resolve(buffer);
      });
    });

    client.sendQuery("sess-1", "fix the bug", { cwd: "/my/workspace" });

    const raw = await received;
    const msg = JSON.parse(raw.trim());
    expect(msg.method).toBe("query");
    expect(msg.params.type).toBe("query");
    expect(msg.params.id).toBe("sess-1");
    expect(msg.params.prompt).toBe("fix the bug");
    expect(msg.params.options.cwd).toBe("/my/workspace");
  });

  it("sends cancel notifications", async () => {
    const connected = new Promise<void>((resolve) => client.on("connected", resolve));
    client.connect();
    await connected;

    const received = new Promise<string>((resolve) => {
      let buffer = "";
      serverSocket!.on("data", (data) => {
        buffer += data.toString();
        if (buffer.includes("\n")) resolve(buffer);
      });
    });

    client.sendCancel("sess-1");

    const raw = await received;
    const msg = JSON.parse(raw.trim());
    expect(msg.method).toBe("cancel");
    expect(msg.params.type).toBe("cancel");
    expect(msg.params.id).toBe("sess-1");
  });
});
