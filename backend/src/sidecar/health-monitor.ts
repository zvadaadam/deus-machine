import { EventEmitter } from 'events';

interface SidecarConfig {
  KEEPALIVE_TIMEOUT: number;
  [key: string]: any;
}

export class HealthMonitor extends EventEmitter {
  private config: SidecarConfig;
  private lastKeepalive: number | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private isMonitoring = false;

  constructor(config: SidecarConfig) {
    super();
    this.config = config;
  }

  start(): void {
    if (this.isMonitoring) return;

    this.lastKeepalive = Date.now();
    this.isMonitoring = true;

    console.log('[HEALTH] Starting health monitoring');
    this.healthCheckTimer = setInterval(() => {
      this._checkHealth();
    }, 15000);
  }

  stop(): void {
    if (!this.isMonitoring) return;

    console.log('[HEALTH] Stopping health monitoring');
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    this.lastKeepalive = null;
    this.isMonitoring = false;
  }

  updateKeepalive(): void {
    this.lastKeepalive = Date.now();
  }

  private _checkHealth(): void {
    if (!this.lastKeepalive) return;

    const timeSinceLastKeepalive = Date.now() - this.lastKeepalive;
    if (timeSinceLastKeepalive > this.config.KEEPALIVE_TIMEOUT) {
      console.error(`[HEALTH] No keepalive for ${timeSinceLastKeepalive}ms - sidecar may be dead`);
      this.emit('unhealthy', { timeSinceLastKeepalive });
    }
  }

  getStatus(): { isMonitoring: boolean; lastKeepalive: number | null; timeSinceKeepalive: number | null } {
    return {
      isMonitoring: this.isMonitoring,
      lastKeepalive: this.lastKeepalive,
      timeSinceKeepalive: this.lastKeepalive ? Date.now() - this.lastKeepalive : null,
    };
  }
}
