#!/usr/bin/env node

/**
 * OpenDevs Sidecar - Unix Domain Socket Server
 *
 * This is a lightweight IPC layer that:
 * 1. Creates a Unix Domain Socket for real-time communication
 * 2. Receives NDJSON messages from Tauri Rust
 * 3. Delegates to backend HTTP API for actual work
 * 4. Streams responses back via socket
 *
 * Architecture:
 * React → Tauri → Unix Socket (this file) → HTTP Backend → Claude CLI
 */

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Use dynamic backend port from environment variable
const BACKEND_PORT = process.env.BACKEND_PORT || '3333';
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const SOCKET_PATH = path.join(os.tmpdir(), `conductor-claude-${process.pid}.sock`);

console.log(`[SIDECAR] Using backend at ${BACKEND_URL}`);

/**
 * Unix Socket Server
 */
class UnixSocketServer {
  constructor() {
    this.server = null;
    this.clients = new Set();
  }

  /**
   * Start the Unix socket server
   */
  async start() {
    // Remove old socket if exists
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.listen(SOCKET_PATH, () => {
        console.log('[SOCKET] ✅ Unix socket server started');
        console.log(`SOCKET_PATH=${SOCKET_PATH}`);
        resolve();
      });

      this.server.on('error', (error) => {
        console.error('[SOCKET] ❌ Server error:', error);
        reject(error);
      });
    });
  }

  /**
   * Handle new client connection
   */
  handleConnection(socket) {
    console.log('[SOCKET] 🔌 Client connected');
    this.clients.add(socket);

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      // Process complete lines (NDJSON protocol)
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          this.handleMessage(socket, line);
        }
      }
    });

    socket.on('end', () => {
      console.log('[SOCKET] 🔌 Client disconnected');
      this.clients.delete(socket);
    });

    socket.on('error', (error) => {
      console.error('[SOCKET] ❌ Socket error:', error);
      this.clients.delete(socket);
    });
  }

  /**
   * Handle incoming NDJSON message
   */
  async handleMessage(socket, line) {
    try {
      const message = JSON.parse(line);
      console.log('[SOCKET] 📨 Received:', message.command || message.type);

      const response = await this.routeMessage(message);
      this.send(socket, response);
    } catch (error) {
      console.error('[SOCKET] ❌ Error handling message:', error);
      this.send(socket, { error: error.message });
    }
  }

  /**
   * Route message to appropriate backend endpoint
   */
  async routeMessage(message) {
    const { command, ...data } = message;

    switch (command) {
      case 'start_session':
        return await this.httpPost('/api/sessions/start', data);

      case 'send_message':
        return await this.httpPost('/api/sessions/message', data);

      case 'stop_session':
        return await this.httpPost('/api/sessions/stop', data);

      case 'get_status':
        return await this.httpGet('/api/sidecar/status');

      case 'get_messages':
        const { sessionId } = data;
        return await this.httpGet(`/api/sessions/${sessionId}/messages`);

      default:
        console.warn('[SOCKET] ⚠️  Unknown command:', command);
        return { error: 'Unknown command', command };
    }
  }

  /**
   * Make HTTP GET request to backend
   */
  httpGet(path) {
    return new Promise((resolve, reject) => {
      http.get(`${BACKEND_URL}${path}`, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            resolve({ error: 'Invalid JSON response' });
          }
        });
      }).on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Make HTTP POST request to backend
   */
  httpPost(path, body) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(body);

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = http.request(`${BACKEND_URL}${path}`, options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            resolve({ error: 'Invalid JSON response' });
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Send NDJSON message to client
   */
  send(socket, message) {
    try {
      const json = JSON.stringify(message) + '\n';
      socket.write(json);
    } catch (error) {
      console.error('[SOCKET] ❌ Error sending message:', error);
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(message) {
    for (const client of this.clients) {
      this.send(client, message);
    }
  }

  /**
   * Stop the server
   */
  stop() {
    if (this.server) {
      this.server.close();

      // Close all client connections
      for (const client of this.clients) {
        client.end();
      }

      // Remove socket file
      if (fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
      }

      console.log('[SOCKET] 👋 Server stopped');
    }
  }
}

/**
 * Keepalive sender
 */
function startKeepalive(server, interval = 30000) {
  return setInterval(() => {
    server.broadcast({ type: 'keepalive', timestamp: Date.now() });
  }, interval);
}

/**
 * Main entry point
 */
async function main() {
  console.log('\n🚀 OpenDevs Sidecar - Unix Socket Server');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const server = new UnixSocketServer();

  try {
    await server.start();

    // Start keepalive
    const keepaliveInterval = startKeepalive(server);

    console.log('✅ Sidecar ready!\n');

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n👋 Shutting down...');
      clearInterval(keepaliveInterval);
      server.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\n👋 Shutting down...');
      clearInterval(keepaliveInterval);
      server.stop();
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ Failed to start sidecar:', error);
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
