import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { HealthMonitor } from '../health-monitor';
import { SocketManager } from '../socket-manager';
import { MessageHandler } from '../message-handler';
import { buildKeepalive, buildResultMessage, toNDJSON } from './builders';

/**
 * Integration tests for the sidecar message pipeline.
 *
 * These tests use a real in-memory SQLite database instead of mocks,
 * verifying that messages flow through MessageHandler and get persisted
 * correctly. The HealthMonitor is wired up to verify keepalive handling.
 *
 * This does NOT start the actual sidecar process or Claude CLI.
 */

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create the tables that the sidecar expects
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'idle',
      claude_session_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      role TEXT,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      sent_at TEXT,
      model TEXT,
      sdk_message_id TEXT,
      last_assistant_message_id TEXT,
      cancelled_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  return db;
}

describe('Sidecar integration: MessageHandler + real SQLite', () => {
  let db: Database.Database;
  let handler: MessageHandler;

  beforeEach(() => {
    db = createTestDb();
    handler = new MessageHandler(db);
  });

  afterEach(() => {
    db.close();
  });

  it('saves a result message to the database', () => {
    const sessionId = 'sess-integration-1';
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run(sessionId, 'working');

    const message = buildResultMessage(sessionId);
    const result = handler.handle(message);

    expect(result).toBe('result');

    // Verify the message was actually inserted
    const row = db.prepare(
      'SELECT * FROM session_messages WHERE session_id = ?'
    ).get(sessionId) as any;

    expect(row).toBeDefined();
    expect(row.session_id).toBe(sessionId);
    expect(row.role).toBe('assistant');
    expect(row.content).toBeDefined();
    expect(row.id).toBeTruthy();
  });

  it('updates session status to idle when stop_reason is set', () => {
    const sessionId = 'sess-integration-2';
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run(sessionId, 'working');

    const message = buildResultMessage(sessionId, { stop_reason: 'end_turn' });
    handler.handle(message);

    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as any;
    expect(session.status).toBe('idle');
  });

  it('updates session status to idle when is_final is true', () => {
    const sessionId = 'sess-integration-3';
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run(sessionId, 'working');

    const message = buildResultMessage(sessionId, { is_final: true });
    handler.handle(message);

    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as any;
    expect(session.status).toBe('idle');
  });

  it('does not update session status when message is partial', () => {
    const sessionId = 'sess-integration-4';
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run(sessionId, 'working');

    // No stop_reason or is_final
    const message = buildResultMessage(sessionId, {
      stop_reason: undefined,
      is_final: undefined,
    });
    delete message.stop_reason;
    delete message.is_final;
    handler.handle(message);

    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as any;
    expect(session.status).toBe('working');
  });

  it('handles multiple messages for the same session', () => {
    const sessionId = 'sess-integration-5';
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run(sessionId, 'working');

    // Send 3 result messages
    handler.handle(buildResultMessage(sessionId));
    handler.handle(buildResultMessage(sessionId));
    handler.handle(buildResultMessage(sessionId));

    const count = db.prepare(
      'SELECT COUNT(*) as count FROM session_messages WHERE session_id = ?'
    ).get(sessionId) as any;
    expect(count.count).toBe(3);
  });

  it('each message gets a unique ID', () => {
    const sessionId = 'sess-integration-6';
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run(sessionId, 'working');

    handler.handle(buildResultMessage(sessionId));
    handler.handle(buildResultMessage(sessionId));

    const rows = db.prepare(
      'SELECT id FROM session_messages WHERE session_id = ?'
    ).all(sessionId) as any[];
    expect(rows[0].id).not.toBe(rows[1].id);
  });
});

describe('Sidecar integration: MessageHandler + HealthMonitor wiring', () => {
  let db: Database.Database;
  let handler: MessageHandler;
  let healthMonitor: HealthMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    handler = new MessageHandler(db);
    healthMonitor = new HealthMonitor({ KEEPALIVE_TIMEOUT: 60000 });
    healthMonitor.start();
  });

  afterEach(() => {
    healthMonitor.stop();
    db.close();
    vi.useRealTimers();
  });

  it('keepalive messages update health monitor and skip DB', () => {
    const keepalive = buildKeepalive();
    const messageType = handler.handle(keepalive);

    // MessageHandler returns 'keep_alive' so the caller can update health
    expect(messageType).toBe('keep_alive');

    // Verify no DB writes happened
    const count = db.prepare('SELECT COUNT(*) as count FROM session_messages').get() as any;
    expect(count.count).toBe(0);

    // Simulate the wiring: caller updates health on keep_alive
    if (messageType === 'keep_alive') {
      healthMonitor.updateKeepalive();
    }

    // Health monitor should be fresh
    expect(healthMonitor.getStatus().timeSinceKeepalive).toBeLessThanOrEqual(1);
  });

  it('full pipeline: messages are saved, keepalives keep health fresh', () => {
    const sessionId = 'sess-pipeline';
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run(sessionId, 'working');

    const unhealthyHandler = vi.fn();
    healthMonitor.on('unhealthy', unhealthyHandler);

    // Simulate a stream of messages over time
    const messages = [
      buildKeepalive(),
      buildResultMessage(sessionId),
      buildKeepalive(),
      buildResultMessage(sessionId, { stop_reason: 'end_turn' }),
    ];

    for (const msg of messages) {
      const type = handler.handle(msg);
      if (type === 'keep_alive') {
        healthMonitor.updateKeepalive();
      }
      vi.advanceTimersByTime(10000); // 10s between messages
    }

    // Should have 2 saved messages (result messages only)
    const count = db.prepare(
      'SELECT COUNT(*) as count FROM session_messages WHERE session_id = ?'
    ).get(sessionId) as any;
    expect(count.count).toBe(2);

    // Session should be idle after final message
    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as any;
    expect(session.status).toBe('idle');

    // Health monitor should not have fired unhealthy (keepalives came in)
    expect(unhealthyHandler).not.toHaveBeenCalled();
  });

  it('no keepalives causes unhealthy event', () => {
    const unhealthyHandler = vi.fn();
    healthMonitor.on('unhealthy', unhealthyHandler);

    // Advance past keepalive timeout without any keepalive updates
    vi.advanceTimersByTime(75000);

    expect(unhealthyHandler).toHaveBeenCalled();
  });
});

describe('Sidecar integration: SocketManager + MessageHandler + real Unix socket + real SQLite', () => {
  let db: Database.Database;
  let handler: MessageHandler;
  let healthMonitor: HealthMonitor;
  let socketManager: SocketManager;
  let mockServer: net.Server;
  let socketPath: string;
  let serverSocket: net.Socket | null = null;

  beforeEach(async () => {
    db = createTestDb();
    handler = new MessageHandler(db);
    healthMonitor = new HealthMonitor({ KEEPALIVE_TIMEOUT: 60000 });

    socketManager = new SocketManager({
      RECONNECT_INTERVAL: 1000,
      MAX_RECONNECT_INTERVAL: 5000,
      RECONNECT_BACKOFF: 1.5,
      MAX_RECONNECT_ATTEMPTS: 3,
    });

    // Wire up the same event flow as SidecarManager
    socketManager.on('message', (message: any) => {
      const type = handler.handle(message);
      if (type === 'keep_alive') {
        healthMonitor.updateKeepalive();
      }
    });

    socketManager.on('connected', () => {
      healthMonitor.start();
    });

    socketManager.on('closed', () => {
      healthMonitor.stop();
    });

    // Create a real Unix socket server
    socketPath = path.join(os.tmpdir(), `conductor-test-${process.pid}-${Date.now()}.sock`);

    await new Promise<void>((resolve) => {
      mockServer = net.createServer((client) => {
        serverSocket = client;
      });
      mockServer.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    socketManager.disconnect();
    healthMonitor.stop();

    await new Promise<void>((resolve) => {
      if (serverSocket) serverSocket.destroy();
      mockServer.close(() => resolve());
    });

    // Clean up socket file
    try { fs.unlinkSync(socketPath); } catch {}

    db.close();
  });

  it('receives NDJSON messages through a real Unix socket and saves to DB', async () => {
    const sessionId = 'sess-socket-1';
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run(sessionId, 'working');

    // Connect through the real socket
    socketManager.connect(socketPath);

    // Wait for connection
    await new Promise<void>((resolve) => {
      socketManager.on('connected', resolve);
    });

    expect(socketManager.isConnected()).toBe(true);

    // Wait for server to see the client
    await new Promise<void>((resolve) => {
      if (serverSocket) return resolve();
      mockServer.once('connection', () => resolve());
    });

    // Server sends a result message through the socket
    const message = buildResultMessage(sessionId, { stop_reason: 'end_turn' });
    serverSocket!.write(toNDJSON(message));

    // Wait for the message to be processed
    await new Promise<void>((resolve) => {
      socketManager.once('message', () => resolve());
    });

    // Verify it was saved to the database
    const row = db.prepare(
      'SELECT * FROM session_messages WHERE session_id = ?'
    ).get(sessionId) as any;
    expect(row).toBeDefined();
    expect(row.role).toBe('assistant');

    // Verify session status was updated
    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as any;
    expect(session.status).toBe('idle');
  });

  it('handles keepalive through real socket and updates health monitor', async () => {
    socketManager.connect(socketPath);

    await new Promise<void>((resolve) => {
      socketManager.on('connected', resolve);
    });

    await new Promise<void>((resolve) => {
      if (serverSocket) return resolve();
      mockServer.once('connection', () => resolve());
    });

    // Server sends keepalive
    serverSocket!.write(toNDJSON(buildKeepalive()));

    await new Promise<void>((resolve) => {
      socketManager.once('message', () => resolve());
    });

    expect(healthMonitor.getStatus().isMonitoring).toBe(true);
    expect(healthMonitor.getStatus().timeSinceKeepalive).toBeLessThan(1000);
  });

  it('handles multiple rapid messages through real socket', async () => {
    const sessionId = 'sess-socket-rapid';
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run(sessionId, 'working');

    socketManager.connect(socketPath);

    await new Promise<void>((resolve) => {
      socketManager.on('connected', resolve);
    });

    await new Promise<void>((resolve) => {
      if (serverSocket) return resolve();
      mockServer.once('connection', () => resolve());
    });

    // Send 5 messages rapidly
    const messageCount = 5;
    let received = 0;

    const allReceived = new Promise<void>((resolve) => {
      socketManager.on('message', () => {
        received++;
        if (received >= messageCount) resolve();
      });
    });

    for (let i = 0; i < messageCount; i++) {
      serverSocket!.write(toNDJSON(buildResultMessage(sessionId)));
    }

    await allReceived;

    const count = db.prepare(
      'SELECT COUNT(*) as count FROM session_messages WHERE session_id = ?'
    ).get(sessionId) as any;
    expect(count.count).toBe(messageCount);
  });

  it('sends messages from SocketManager to the server', async () => {
    socketManager.connect(socketPath);

    await new Promise<void>((resolve) => {
      socketManager.on('connected', resolve);
    });

    await new Promise<void>((resolve) => {
      if (serverSocket) return resolve();
      mockServer.once('connection', () => resolve());
    });

    // Collect data the server receives
    const serverReceived = new Promise<string>((resolve) => {
      let buffer = '';
      serverSocket!.on('data', (data) => {
        buffer += data.toString();
        if (buffer.includes('\n')) resolve(buffer);
      });
    });

    // Send from client side
    socketManager.send({ type: 'frontend_event', event: 'test:ping' });

    const received = await serverReceived;
    const parsed = JSON.parse(received.trim());
    expect(parsed.type).toBe('frontend_event');
    expect(parsed.event).toBe('test:ping');
  });
});
