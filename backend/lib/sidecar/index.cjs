/**
 * Sidecar Manager (Main Orchestrator)
 *
 * Coordinates all sidecar components:
 * - Process Management
 * - Socket Communication
 * - Health Monitoring
 * - Message Handling
 *
 * This is the main entry point for sidecar functionality.
 * Clean separation of concerns makes it easy to test and maintain.
 *
 * @module sidecar
 */

const { ProcessManager } = require('./process-manager.cjs');
const { SocketManager } = require('./socket-manager.cjs');
const { HealthMonitor } = require('./health-monitor.cjs');
const { MessageHandler } = require('./message-handler.cjs');
const { getDatabase } = require('../database.cjs');

/**
 * Configuration constants
 */
const CONFIG = {
  RECONNECT_INTERVAL: 1000,       // Start with 1 second
  MAX_RECONNECT_INTERVAL: 30000,  // Max 30 seconds
  RECONNECT_BACKOFF: 1.5,          // Exponential backoff multiplier
  MAX_RECONNECT_ATTEMPTS: 10,     // Max attempts before giving up
  KEEPALIVE_INTERVAL: 30000,      // Expect keepalive every 30 seconds
  KEEPALIVE_TIMEOUT: 60000,       // Consider dead after 60 seconds
  RESTART_DELAY: 2000,            // Wait 2 seconds before auto-restart
  SHUTDOWN_TIMEOUT: 5000,         // Wait 5 seconds for graceful shutdown
};

/**
 * Sidecar Manager Class
 *
 * Orchestrates all sidecar components and provides a clean API
 * for starting, stopping, and communicating with the sidecar.
 */
class SidecarManager {
  constructor() {
    // Initialize all components (but don't access DB until needed)
    this.processManager = new ProcessManager(CONFIG);
    this.socketManager = new SocketManager(CONFIG);
    this.healthMonitor = new HealthMonitor(CONFIG);
    this.messageHandler = null; // Lazy-initialized when needed

    // Setup event handlers to coordinate components
    this._setupEventHandlers();
  }

  /**
   * Get or create message handler (lazy initialization)
   * @private
   */
  _getMessageHandler() {
    if (!this.messageHandler) {
      const db = getDatabase();
      this.messageHandler = new MessageHandler(db);
    }
    return this.messageHandler;
  }

  /**
   * Setup event handlers to coordinate all components
   * @private
   */
  _setupEventHandlers() {
    // When process starts, connect socket
    this.processManager.on('started', ({ socketPath }) => {
      this.socketManager.connect(socketPath);
    });

    // When socket connects, start health monitoring
    this.socketManager.on('connected', () => {
      this.healthMonitor.start();
    });

    // When socket closes, stop health monitoring
    this.socketManager.on('closed', () => {
      this.healthMonitor.stop();
    });

    // Handle incoming messages
    this.socketManager.on('message', (message) => {
      const messageHandler = this._getMessageHandler();
      const messageType = messageHandler.handle(message);

      // Update keepalive for health monitoring
      if (messageType === 'keep_alive') {
        this.healthMonitor.updateKeepalive();
      }
    });

    // Handle health failures
    this.healthMonitor.on('unhealthy', () => {
      console.log('[SIDECAR] 🔄 Health check failed - attempting restart...');
      // Kill process to trigger auto-restart
      if (this.processManager.isRunning()) {
        this.processManager.process.kill('SIGTERM');
      }
    });

    // Handle process exit
    this.processManager.on('exit', () => {
      this.socketManager.disconnect();
      this.healthMonitor.stop();
    });
  }

  /**
   * Start the sidecar
   * @param {string} dbPath - Path to the database
   * @returns {Promise<{pid: number, socketPath: string}>}
   */
  async start(dbPath) {
    return await this.processManager.start(dbPath);
  }

  /**
   * Stop the sidecar
   */
  stop() {
    this.healthMonitor.stop();
    this.socketManager.disconnect();
    this.processManager.stop();
  }

  /**
   * Send a message to the sidecar
   * @param {Object} message - Message to send
   * @returns {boolean}
   */
  send(message) {
    return this.socketManager.send(message);
  }

  /**
   * Get comprehensive sidecar status
   * @returns {Object}
   */
  getStatus() {
    return {
      ...this.processManager.getStatus(),
      ...this.socketManager.getStatus(),
      ...this.healthMonitor.getStatus(),
    };
  }

  /**
   * Enable auto-restart on crash
   */
  enableAutoRestart() {
    this.processManager.enableAutoRestart();
  }

  /**
   * Disable auto-restart on crash
   */
  disableAutoRestart() {
    this.processManager.disableAutoRestart();
  }
}

// Create singleton instance
let sidecarManager = null;

/**
 * Get or create the sidecar manager instance
 * @returns {SidecarManager}
 */
function getSidecarManager() {
  if (!sidecarManager) {
    sidecarManager = new SidecarManager();
  }
  return sidecarManager;
}

/**
 * Start the sidecar (convenience function)
 * @param {string} dbPath - Path to the database
 * @returns {Promise<{pid: number, socketPath: string}>}
 */
async function startSidecar(dbPath) {
  const manager = getSidecarManager();
  return await manager.start(dbPath);
}

/**
 * Stop the sidecar (convenience function)
 */
function stopSidecar() {
  const manager = getSidecarManager();
  manager.stop();
}

/**
 * Send a message to the sidecar (convenience function)
 * @param {Object} message - Message to send
 * @returns {boolean}
 */
function sendToSidecar(message) {
  const manager = getSidecarManager();
  return manager.send(message);
}

/**
 * Get sidecar status (convenience function)
 * @returns {Object}
 */
function getSidecarStatus() {
  const manager = getSidecarManager();
  return manager.getStatus();
}

/**
 * Enable auto-restart (convenience function)
 */
function enableAutoRestart() {
  const manager = getSidecarManager();
  manager.enableAutoRestart();
}

/**
 * Disable auto-restart (convenience function)
 */
function disableAutoRestart() {
  const manager = getSidecarManager();
  manager.disableAutoRestart();
}

// Export the same API as the old monolithic module for backwards compatibility
module.exports = {
  startSidecar,
  stopSidecar,
  sendToSidecar,
  getSidecarStatus,
  enableAutoRestart,
  disableAutoRestart,
  CONFIG,
  // Also export the manager class for advanced usage
  SidecarManager,
  getSidecarManager,
};
