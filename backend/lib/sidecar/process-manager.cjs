/**
 * Sidecar Process Manager
 *
 * Handles the lifecycle of the sidecar Node.js process:
 * - Process spawning and initialization
 * - PID tracking and singleton pattern
 * - Exit handling and auto-restart logic
 * - Graceful shutdown
 *
 * @module sidecar/process-manager
 */

const { spawn } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Process Manager for the sidecar
 * @extends EventEmitter
 */
class ProcessManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.process = null;
    this.pid = null;
    this.socketPath = null;
    this.isStarting = false;
    this.shouldRestart = true;
  }

  /**
   * Check if process is running
   * @returns {boolean}
   */
  isRunning() {
    if (!this.process || !this.pid) return false;

    try {
      // Signal 0 checks if process exists without killing it
      process.kill(this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start the sidecar process (singleton pattern)
   * @param {string} dbPath - Path to the database
   * @returns {Promise<{pid: number, socketPath: string}>}
   */
  async start(dbPath) {
    // Singleton pattern: return existing instance if already running
    if (this.isRunning()) {
      console.log(`[SIDECAR] ✅ Already running (PID: ${this.pid})`);
      return {
        pid: this.pid,
        socketPath: this.socketPath
      };
    }

    // Prevent multiple simultaneous starts
    if (this.isStarting) {
      throw new Error('Sidecar is already starting');
    }

    this.isStarting = true;

    console.log('[SIDECAR] 🚀 Starting sidecar process...');

    // Path to the sidecar script
    const sidecarPath = path.join(__dirname, '../../../src-tauri/sidecar/index.cjs');

    try {
      // Spawn sidecar process
      this.process = spawn('node', [sidecarPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DATABASE_URL: `sqlite:${dbPath}`,
        }
      });

      this.pid = this.process.pid;
      console.log(`[SIDECAR] ✅ Process started (PID: ${this.pid})`);

      // Wait for socket path
      const socketPath = await this._waitForSocketPath();
      this.socketPath = socketPath;

      // Setup exit handler
      this._setupExitHandler(dbPath);

      this.isStarting = false;

      // Emit started event
      this.emit('started', { pid: this.pid, socketPath: this.socketPath });

      return {
        pid: this.pid,
        socketPath: this.socketPath
      };
    } catch (error) {
      this.isStarting = false;
      console.error('[SIDECAR] ❌ Failed to start:', error);
      throw error;
    }
  }

  /**
   * Wait for socket path from stdout
   * @private
   * @returns {Promise<string>}
   */
  _waitForSocketPath() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for socket path'));
      }, 10000);

      // Handle stdout - captures socket path
      this.process.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('[SIDECAR]', output.trim());

        // Extract socket path (format: SOCKET_PATH=/path/to/socket)
        const match = output.match(/SOCKET_PATH=([^\s]+)/);
        if (match) {
          const socketPath = match[1];
          console.log('[SIDECAR] ✅ Socket path:', socketPath);
          clearTimeout(timeout);
          resolve(socketPath);
        }
      });

      // Handle stderr
      this.process.stderr.on('data', (data) => {
        console.error('[SIDECAR ERROR]', data.toString().trim());
      });
    });
  }

  /**
   * Setup exit handler with auto-restart logic
   * @private
   */
  _setupExitHandler(dbPath) {
    this.process.on('exit', (code, signal) => {
      console.log(`[SIDECAR] ⚠️  Process exited (code: ${code}, signal: ${signal})`);

      // Emit exit event
      this.emit('exit', { code, signal });

      // Cleanup state
      const wasRunning = this.process !== null;
      this.socketPath = null;
      this.process = null;
      this.pid = null;

      // Auto-restart logic
      // Restart on: crashes (code !== 0), SIGTERM (health monitor), any signal except SIGKILL
      // Don't restart on: SIGKILL (manual stop), or if shouldRestart is false
      if (this.shouldRestart && signal !== 'SIGKILL' && wasRunning) {
        console.log(`[SIDECAR] 🔄 Auto-restarting in ${this.config.RESTART_DELAY}ms...`);
        setTimeout(() => {
          this.isStarting = false;
          this.start(dbPath).catch(err => {
            console.error('[SIDECAR] ❌ Failed to restart:', err);
            this.emit('restart-failed', err);
          });
        }, this.config.RESTART_DELAY);
      } else {
        this.isStarting = false;
        if (signal === 'SIGKILL') {
          console.log('[SIDECAR] ⏹️  Manual stop - not restarting');
        }
      }
    });
  }

  /**
   * Stop the sidecar process gracefully
   */
  stop() {
    console.log('[SIDECAR] 🛑 Stopping sidecar process...');

    // Disable auto-restart
    this.shouldRestart = false;

    if (this.process) {
      try {
        // Send SIGTERM for graceful shutdown
        this.process.kill('SIGTERM');

        // Force kill after timeout
        setTimeout(() => {
          if (this.process) {
            console.warn('[SIDECAR] ⚠️  Force killing sidecar');
            this.process.kill('SIGKILL');
          }
        }, this.config.SHUTDOWN_TIMEOUT);
      } catch (error) {
        console.error('[SIDECAR] ⚠️  Error killing process:', error);
      }
    }

    // Reset state
    this.socketPath = null;
    this.pid = null;
  }

  /**
   * Enable auto-restart on crash
   */
  enableAutoRestart() {
    this.shouldRestart = true;
    console.log('[SIDECAR] ✅ Auto-restart enabled');
  }

  /**
   * Disable auto-restart on crash
   */
  disableAutoRestart() {
    this.shouldRestart = false;
    console.log('[SIDECAR] ⚠️  Auto-restart disabled');
  }

  /**
   * Get process status
   * @returns {Object}
   */
  getStatus() {
    return {
      running: this.process !== null,
      pid: this.pid,
      socketPath: this.socketPath,
      isStarting: this.isStarting,
      shouldRestart: this.shouldRestart,
    };
  }
}

module.exports = { ProcessManager };
