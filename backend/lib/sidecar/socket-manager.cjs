/**
 * Sidecar Socket Manager
 *
 * Handles Unix domain socket communication with the sidecar:
 * - Socket connection and reconnection
 * - Exponential backoff for reconnection
 * - Message buffering and parsing
 * - Send/receive operations
 *
 * @module sidecar/socket-manager
 */

const net = require('net');
const { EventEmitter } = require('events');

/**
 * Socket Manager for sidecar communication
 * @extends EventEmitter
 */
class SocketManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = null;
    this.socketPath = null;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.reconnectInterval = config.RECONNECT_INTERVAL;
    this.reconnectTimer = null;
    this.buffer = '';
  }

  /**
   * Check if connected
   * @returns {boolean}
   */
  isConnected() {
    return this.client !== null;
  }

  /**
   * Connect to the sidecar socket
   * @param {string} socketPath - Path to Unix domain socket
   */
  connect(socketPath) {
    // Prevent multiple simultaneous connection attempts
    if (this.isConnecting) {
      console.log('[SOCKET] ⏳ Connection already in progress');
      return;
    }

    if (!socketPath) {
      console.warn('[SOCKET] ⚠️  Cannot connect: socket path not available');
      return;
    }

    this.socketPath = socketPath;
    this.isConnecting = true;

    try {
      this.client = net.connect(socketPath, () => {
        console.log('[SOCKET] 🔌 Connected');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.reconnectInterval = this.config.RECONNECT_INTERVAL;
        this.emit('connected');
      });

      // Handle connection errors
      this.client.on('error', (err) => {
        console.error('[SOCKET] ❌ Error:', err.message);
        this.client = null;
        this.isConnecting = false;
        this._scheduleReconnect();
      });

      // Handle socket close
      this.client.on('close', () => {
        console.log('[SOCKET] 🔌 Closed');
        const wasConnected = this.client !== null;
        this.client = null;
        this.isConnecting = false;

        this.emit('closed');

        // Attempt reconnection if we have a socket path
        if (wasConnected && this.socketPath) {
          this._scheduleReconnect();
        }
      });

      // Handle incoming data (newline-delimited JSON)
      this.client.on('data', (data) => {
        this._handleData(data);
      });
    } catch (error) {
      console.error('[SOCKET] ❌ Failed to connect:', error.message);
      this.isConnecting = false;
      this._scheduleReconnect();
    }
  }

  /**
   * Handle incoming data with buffering
   * @private
   */
  _handleData(data) {
    this.buffer += data.toString();

    // Process complete messages (newline-delimited)
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);
        this.emit('message', message);
      } catch (error) {
        console.error('[SOCKET] ❌ Failed to parse message:', line.substring(0, 100), error);
        this.emit('parse-error', { line, error });
      }
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   * @private
   */
  _scheduleReconnect() {
    // Clear existing timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Check if we've exceeded max attempts
    if (this.reconnectAttempts >= this.config.MAX_RECONNECT_ATTEMPTS) {
      console.error('[SOCKET] ❌ Max reconnection attempts exceeded');
      this.emit('max-reconnects-exceeded');
      return;
    }

    this.reconnectAttempts++;

    console.log(
      `[SOCKET] 🔄 Reconnecting in ${this.reconnectInterval}ms (attempt ${this.reconnectAttempts}/${this.config.MAX_RECONNECT_ATTEMPTS})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect(this.socketPath);
      // Increase interval with exponential backoff
      this.reconnectInterval = Math.min(
        this.reconnectInterval * this.config.RECONNECT_BACKOFF,
        this.config.MAX_RECONNECT_INTERVAL
      );
    }, this.reconnectInterval);
  }

  /**
   * Send a message to the sidecar
   * @param {Object} message - Message to send
   * @returns {boolean} True if sent successfully
   */
  send(message) {
    if (this.client && this.socketPath) {
      try {
        this.client.write(JSON.stringify(message) + '\n');
        return true;
      } catch (error) {
        console.error('[SOCKET] ❌ Failed to send message:', error);
        return false;
      }
    }
    console.warn('[SOCKET] ⚠️  Cannot send: not connected');
    return false;
  }

  /**
   * Disconnect from the socket
   */
  disconnect() {
    console.log('[SOCKET] 🛑 Disconnecting...');

    // Clear reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close socket connection
    if (this.client) {
      try {
        this.client.destroy();
      } catch (error) {
        console.error('[SOCKET] ⚠️  Error closing socket:', error);
      }
      this.client = null;
    }

    // Reset state
    this.socketPath = null;
    this.reconnectAttempts = 0;
    this.reconnectInterval = this.config.RECONNECT_INTERVAL;
    this.buffer = '';
  }

  /**
   * Get socket status
   * @returns {Object}
   */
  getStatus() {
    return {
      connected: this.client !== null,
      socketPath: this.socketPath,
      isConnecting: this.isConnecting,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

module.exports = { SocketManager };
