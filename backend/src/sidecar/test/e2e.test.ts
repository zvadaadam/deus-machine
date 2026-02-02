import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'child_process';
import net from 'net';
import http from 'http';
import path from 'path';
import fs from 'fs';

/**
 * E2E tests for the sidecar process (src-tauri/sidecar/index.cjs).
 *
 * These tests start the REAL sidecar process, connect to its Unix socket,
 * and verify the full message flow. A mock HTTP server stands in for the
 * Node.js backend so we can assert what the sidecar forwards.
 *
 * Requires: Node.js (to run index.cjs). No database needed — the sidecar
 * delegates all DB work to the backend HTTP API.
 */

const SIDECAR_PATH = path.resolve(
  __dirname,
  '../../../../src-tauri/sidecar/index.cjs',
);

/** Parse a single NDJSON line from a buffer, returning parsed object or null. */
function parseNDJSON(buffer: string): { parsed: any[]; remainder: string } {
  const lines = buffer.split('\n');
  const remainder = lines.pop() || '';
  const parsed: any[] = [];
  for (const line of lines) {
    if (line.trim()) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }
  return { parsed, remainder };
}

/** Send an NDJSON message to a socket. */
function sendMessage(socket: net.Socket, message: Record<string, any>) {
  socket.write(JSON.stringify(message) + '\n');
}

/** Collect messages from a socket until a predicate matches or timeout. */
function waitForMessage(
  socket: net.Socket,
  predicate: (msg: any) => boolean,
  timeoutMs = 10000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for message (${timeoutMs}ms)`));
    }, timeoutMs);

    function onData(data: Buffer) {
      buffer += data.toString();
      const { parsed, remainder } = parseNDJSON(buffer);
      buffer = remainder;
      for (const msg of parsed) {
        if (predicate(msg)) {
          cleanup();
          resolve(msg);
          return;
        }
      }
    }

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
    }

    socket.on('data', onData);
  });
}

describe('Sidecar E2E: real process + real Unix socket', () => {
  let sidecarProcess: ChildProcess;
  let socketPath: string;
  let mockBackendServer: http.Server;
  let mockBackendPort: number;
  let client: net.Socket;

  // Track requests the mock backend receives
  const receivedRequests: Array<{
    method: string;
    url: string;
    body?: any;
  }> = [];

  beforeAll(async () => {
    // 1. Start a mock HTTP server to act as the backend
    mockBackendServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const entry: any = { method: req.method!, url: req.url! };
        if (body) {
          try {
            entry.body = JSON.parse(body);
          } catch {
            entry.body = body;
          }
        }
        receivedRequests.push(entry);

        // Respond with a simple JSON payload for every request
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, url: req.url }));
      });
    });

    await new Promise<void>((resolve) => {
      mockBackendServer.listen(0, () => resolve());
    });
    mockBackendPort = (mockBackendServer.address() as net.AddressInfo).port;

    // 2. Spawn the real sidecar process
    sidecarProcess = spawn('node', [SIDECAR_PATH], {
      env: {
        ...process.env,
        BACKEND_PORT: String(mockBackendPort),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 3. Parse SOCKET_PATH from stdout
    socketPath = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Sidecar did not output SOCKET_PATH within 10s. Got: ${output}`,
          ),
        );
      }, 10000);

      sidecarProcess.stdout!.on('data', (data) => {
        output += data.toString();
        const match = output.match(/SOCKET_PATH=(.+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1].trim());
        }
      });

      sidecarProcess.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      sidecarProcess.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Sidecar exited early with code ${code}. Output: ${output}`));
      });
    });

    // 4. Connect a client to the sidecar's Unix socket
    client = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.connect(socketPath, () => resolve(sock));
      sock.on('error', reject);
    });
  }, 30000); // generous timeout for process startup

  afterAll(async () => {
    // Disconnect client
    if (client) {
      client.destroy();
    }

    // Kill sidecar process
    if (sidecarProcess && !sidecarProcess.killed) {
      sidecarProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        sidecarProcess.on('exit', () => resolve());
        setTimeout(resolve, 3000); // fallback if it doesn't exit cleanly
      });
    }

    // Stop mock backend
    if (mockBackendServer) {
      await new Promise<void>((resolve) => {
        mockBackendServer.close(() => resolve());
      });
    }

    // Clean up socket file
    if (socketPath) {
      try {
        fs.unlinkSync(socketPath);
      } catch {}
    }
  }, 10000);

  it('sidecar process is running and socket exists', () => {
    expect(sidecarProcess.killed).toBe(false);
    expect(socketPath).toBeTruthy();
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('client is connected to the sidecar', () => {
    expect(client).toBeDefined();
    expect(client.destroyed).toBe(false);
  });

  it('receives keepalive messages from the sidecar', async () => {
    // Sidecar sends keepalives every 30s, but we don't want to wait that long.
    // Instead we just verify the shape of whatever message arrives first.
    // If we already got a keepalive during setup, this will resolve quickly.
    const msg = await waitForMessage(
      client,
      (m) => m.type === 'keep_alive',
      35000, // slightly longer than the 30s keepalive interval
    );

    expect(msg.type).toBe('keep_alive');
    expect(msg.timestamp).toBeTypeOf('number');
  }, 40000);

  it('forwards get_status command to the backend via HTTP GET', async () => {
    receivedRequests.length = 0;

    const responsePromise = waitForMessage(
      client,
      (m) => m.ok === true && m.url === '/api/sidecar/status',
      5000,
    );

    sendMessage(client, { command: 'get_status' });

    const response = await responsePromise;
    expect(response.ok).toBe(true);
    expect(response.url).toBe('/api/sidecar/status');

    // Verify the mock backend actually received the request
    const req = receivedRequests.find((r) => r.url === '/api/sidecar/status');
    expect(req).toBeDefined();
    expect(req!.method).toBe('GET');
  });

  it('forwards send_message command to the backend via HTTP POST', async () => {
    receivedRequests.length = 0;

    const responsePromise = waitForMessage(
      client,
      (m) => m.ok === true && m.url === '/api/sessions/message',
      5000,
    );

    sendMessage(client, {
      command: 'send_message',
      sessionId: 'test-sess',
      content: 'Hello from E2E',
    });

    const response = await responsePromise;
    expect(response.ok).toBe(true);

    // Verify the backend received the POST with correct body
    const req = receivedRequests.find((r) => r.url === '/api/sessions/message');
    expect(req).toBeDefined();
    expect(req!.method).toBe('POST');
    expect(req!.body.sessionId).toBe('test-sess');
    expect(req!.body.content).toBe('Hello from E2E');
  });

  it('forwards start_session command to the backend via HTTP POST', async () => {
    receivedRequests.length = 0;

    const responsePromise = waitForMessage(
      client,
      (m) => m.ok === true && m.url === '/api/sessions/start',
      5000,
    );

    sendMessage(client, {
      command: 'start_session',
      workspaceId: 'ws-123',
    });

    const response = await responsePromise;
    expect(response.ok).toBe(true);

    const req = receivedRequests.find((r) => r.url === '/api/sessions/start');
    expect(req).toBeDefined();
    expect(req!.method).toBe('POST');
    expect(req!.body.workspaceId).toBe('ws-123');
  });

  it('forwards stop_session command to the backend via HTTP POST', async () => {
    receivedRequests.length = 0;

    const responsePromise = waitForMessage(
      client,
      (m) => m.ok === true && m.url === '/api/sessions/stop',
      5000,
    );

    sendMessage(client, {
      command: 'stop_session',
      sessionId: 'test-sess-stop',
    });

    const response = await responsePromise;
    expect(response.ok).toBe(true);

    const req = receivedRequests.find((r) => r.url === '/api/sessions/stop');
    expect(req).toBeDefined();
    expect(req!.method).toBe('POST');
    expect(req!.body.sessionId).toBe('test-sess-stop');
  });

  it('forwards get_messages command to the backend via HTTP GET', async () => {
    receivedRequests.length = 0;

    const responsePromise = waitForMessage(
      client,
      (m) => m.ok === true,
      5000,
    );

    sendMessage(client, {
      command: 'get_messages',
      sessionId: 'sess-msg-1',
    });

    const response = await responsePromise;
    expect(response.ok).toBe(true);

    const req = receivedRequests.find(
      (r) => r.url === '/api/sessions/sess-msg-1/messages',
    );
    expect(req).toBeDefined();
    expect(req!.method).toBe('GET');
  });

  it('broadcasts frontend_event to connected clients', async () => {
    const responsePromise = waitForMessage(
      client,
      (m) => m.type === 'frontend_event' && m.event === 'test:ping',
      5000,
    );

    sendMessage(client, {
      type: 'frontend_event',
      event: 'test:ping',
      payload: { ts: 123 },
    });

    const msg = await responsePromise;
    expect(msg.type).toBe('frontend_event');
    expect(msg.event).toBe('test:ping');
    expect(msg.payload.ts).toBe(123);

    // frontend_event should NOT be forwarded to the backend
    const backendReq = receivedRequests.find(
      (r) => r.url?.includes('frontend_event'),
    );
    expect(backendReq).toBeUndefined();
  });

  it('returns error for unknown commands', async () => {
    const responsePromise = waitForMessage(
      client,
      (m) => m.error !== undefined,
      5000,
    );

    sendMessage(client, { command: 'nonexistent_command' });

    const response = await responsePromise;
    expect(response.error).toBe('Unknown command');
    expect(response.command).toBe('nonexistent_command');
  });

  it('handles multiple clients simultaneously', async () => {
    // Connect a second client
    const client2 = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.connect(socketPath, () => resolve(sock));
      sock.on('error', reject);
    });

    try {
      // Both clients should receive a broadcast
      const client1Promise = waitForMessage(
        client,
        (m) => m.type === 'frontend_event' && m.event === 'multi:test',
        5000,
      );
      const client2Promise = waitForMessage(
        client2,
        (m) => m.type === 'frontend_event' && m.event === 'multi:test',
        5000,
      );

      // Send from client2 — both should receive the broadcast
      sendMessage(client2, {
        type: 'frontend_event',
        event: 'multi:test',
        payload: { from: 'client2' },
      });

      const [msg1, msg2] = await Promise.all([client1Promise, client2Promise]);
      expect(msg1.event).toBe('multi:test');
      expect(msg2.event).toBe('multi:test');
    } finally {
      client2.destroy();
    }
  });
});
