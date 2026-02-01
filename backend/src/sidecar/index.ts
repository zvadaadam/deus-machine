import { ProcessManager } from './process-manager';
import { SocketManager } from './socket-manager';
import { HealthMonitor } from './health-monitor';
import { MessageHandler } from './message-handler';
import { getDatabase } from '../lib/database';

const CONFIG = {
  RECONNECT_INTERVAL: 1000,
  MAX_RECONNECT_INTERVAL: 30000,
  RECONNECT_BACKOFF: 1.5,
  MAX_RECONNECT_ATTEMPTS: 10,
  KEEPALIVE_INTERVAL: 30000,
  KEEPALIVE_TIMEOUT: 60000,
  RESTART_DELAY: 2000,
  SHUTDOWN_TIMEOUT: 5000,
};

class SidecarManager {
  processManager: ProcessManager;
  socketManager: SocketManager;
  healthMonitor: HealthMonitor;
  private messageHandler: MessageHandler | null = null;

  constructor() {
    this.processManager = new ProcessManager(CONFIG);
    this.socketManager = new SocketManager(CONFIG);
    this.healthMonitor = new HealthMonitor(CONFIG);
    this._setupEventHandlers();
  }

  private _getMessageHandler(): MessageHandler {
    if (!this.messageHandler) {
      const db = getDatabase();
      this.messageHandler = new MessageHandler(db);
    }
    return this.messageHandler;
  }

  private _setupEventHandlers(): void {
    this.processManager.on('started', ({ socketPath }: { socketPath: string }) => {
      this.socketManager.connect(socketPath);
    });

    this.socketManager.on('connected', () => {
      this.healthMonitor.start();
    });

    this.socketManager.on('closed', () => {
      this.healthMonitor.stop();
    });

    this.socketManager.on('message', (message: any) => {
      const messageHandler = this._getMessageHandler();
      const messageType = messageHandler.handle(message);

      if (messageType === 'keep_alive') {
        this.healthMonitor.updateKeepalive();
      }
    });

    this.healthMonitor.on('unhealthy', () => {
      console.log('[SIDECAR] Health check failed - attempting restart...');
      if (this.processManager.isRunning()) {
        this.processManager.process!.kill('SIGTERM');
      }
    });

    this.processManager.on('exit', () => {
      this.socketManager.disconnect();
      this.healthMonitor.stop();
    });
  }

  async start(dbPath: string): Promise<{ pid: number; socketPath: string }> {
    return await this.processManager.start(dbPath);
  }

  stop(): void {
    this.healthMonitor.stop();
    this.socketManager.disconnect();
    this.processManager.stop();
  }

  send(message: Record<string, any>): boolean {
    return this.socketManager.send(message);
  }

  getStatus(): Record<string, any> {
    return {
      ...this.processManager.getStatus(),
      ...this.socketManager.getStatus(),
      ...this.healthMonitor.getStatus(),
    };
  }

  enableAutoRestart(): void {
    this.processManager.enableAutoRestart();
  }

  disableAutoRestart(): void {
    this.processManager.disableAutoRestart();
  }
}

let sidecarManager: SidecarManager | null = null;

export function getSidecarManager(): SidecarManager {
  if (!sidecarManager) {
    sidecarManager = new SidecarManager();
  }
  return sidecarManager;
}

export async function startSidecar(dbPath: string): Promise<{ pid: number; socketPath: string }> {
  const manager = getSidecarManager();
  return await manager.start(dbPath);
}

export function stopSidecar(): void {
  const manager = getSidecarManager();
  manager.stop();
}

export function sendToSidecar(message: Record<string, any>): boolean {
  const manager = getSidecarManager();
  return manager.send(message);
}

export function getSidecarStatus(): Record<string, any> {
  const manager = getSidecarManager();
  return manager.getStatus();
}

export function enableAutoRestart(): void {
  const manager = getSidecarManager();
  manager.enableAutoRestart();
}

export function disableAutoRestart(): void {
  const manager = getSidecarManager();
  manager.disableAutoRestart();
}

export { CONFIG, SidecarManager };
