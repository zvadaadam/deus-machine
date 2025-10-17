/**
 * Sidecar Health Monitor
 *
 * Monitors the health of the sidecar process by tracking keepalive messages:
 * - Keepalive timestamp tracking
 * - Timeout detection
 * - Auto-restart triggering
 *
 * @module sidecar/health-monitor
 */

const { EventEmitter } = require('events');

/**
 * Health Monitor for sidecar
 * @extends EventEmitter
 */
class HealthMonitor extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.lastKeepalive = null;
    this.healthCheckTimer = null;
    this.isMonitoring = false;
  }

  /**
   * Start health monitoring
   */
  start() {
    if (this.isMonitoring) {
      console.log('[HEALTH] ⚠️  Already monitoring');
      return;
    }

    this.lastKeepalive = Date.now();
    this.isMonitoring = true;

    console.log('[HEALTH] 🏥 Starting health monitoring');

    // Check health every 15 seconds
    this.healthCheckTimer = setInterval(() => {
      this._checkHealth();
    }, 15000);
  }

  /**
   * Stop health monitoring
   */
  stop() {
    if (!this.isMonitoring) {
      return;
    }

    console.log('[HEALTH] 🛑 Stopping health monitoring');

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    this.lastKeepalive = null;
    this.isMonitoring = false;
  }

  /**
   * Update keepalive timestamp
   */
  updateKeepalive() {
    this.lastKeepalive = Date.now();
  }

  /**
   * Check health status
   * @private
   */
  _checkHealth() {
    if (!this.lastKeepalive) {
      return;
    }

    const timeSinceLastKeepalive = Date.now() - this.lastKeepalive;

    if (timeSinceLastKeepalive > this.config.KEEPALIVE_TIMEOUT) {
      console.error(`[HEALTH] ❌ No keepalive for ${timeSinceLastKeepalive}ms - sidecar may be dead`);
      this.emit('unhealthy', { timeSinceLastKeepalive });
    }
  }

  /**
   * Get health status
   * @returns {Object}
   */
  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      lastKeepalive: this.lastKeepalive,
      timeSinceKeepalive: this.lastKeepalive ? Date.now() - this.lastKeepalive : null,
    };
  }
}

module.exports = { HealthMonitor };
