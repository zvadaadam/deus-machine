import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface SidecarConfig {
  RECONNECT_INTERVAL: number;
  MAX_RECONNECT_INTERVAL: number;
  RECONNECT_BACKOFF: number;
  MAX_RECONNECT_ATTEMPTS: number;
  KEEPALIVE_INTERVAL: number;
  KEEPALIVE_TIMEOUT: number;
  RESTART_DELAY: number;
  SHUTDOWN_TIMEOUT: number;
}

export class ProcessManager extends EventEmitter {
  private config: SidecarConfig;
  private process: ChildProcess | null = null;
  private pid: number | null = null;
  private socketPath: string | null = null;
  private isStarting = false;
  private shouldRestart = true;

  constructor(config: SidecarConfig) {
    super();
    this.config = config;
  }

  isRunning(): boolean {
    if (!this.process || !this.pid) return false;

    try {
      process.kill(this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async start(dbPath: string): Promise<{ pid: number; socketPath: string }> {
    if (this.isRunning()) {
      console.log(`[SIDECAR] Already running (PID: ${this.pid})`);
      return { pid: this.pid!, socketPath: this.socketPath! };
    }

    if (this.isStarting) {
      throw new Error('Sidecar is already starting');
    }

    this.isStarting = true;
    console.log('[SIDECAR] Starting sidecar process...');

    const sidecarPath = path.join(__dirname, '../../../src-tauri/sidecar/index.cjs');

    try {
      this.process = spawn('node', [sidecarPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DATABASE_URL: `sqlite:${dbPath}` },
      });

      this.pid = this.process.pid!;
      console.log(`[SIDECAR] Process started (PID: ${this.pid})`);

      const socketPath = await this._waitForSocketPath();
      this.socketPath = socketPath;

      this._setupExitHandler(dbPath);
      this.isStarting = false;

      this.emit('started', { pid: this.pid, socketPath: this.socketPath });

      return { pid: this.pid, socketPath: this.socketPath };
    } catch (error) {
      this.isStarting = false;
      console.error('[SIDECAR] Failed to start:', error);
      throw error;
    }
  }

  private _waitForSocketPath(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for socket path'));
      }, 10000);

      this.process!.stdout!.on('data', (data: Buffer) => {
        const output = data.toString();
        console.log('[SIDECAR]', output.trim());

        const match = output.match(/SOCKET_PATH=([^\s]+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });

      this.process!.stderr!.on('data', (data: Buffer) => {
        console.error('[SIDECAR ERROR]', data.toString().trim());
      });
    });
  }

  private _setupExitHandler(dbPath: string): void {
    this.process!.on('exit', (code, signal) => {
      console.log(`[SIDECAR] Process exited (code: ${code}, signal: ${signal})`);

      this.emit('exit', { code, signal });

      const wasRunning = this.process !== null;
      this.socketPath = null;
      this.process = null;
      this.pid = null;

      if (this.shouldRestart && signal !== 'SIGKILL' && wasRunning) {
        console.log(`[SIDECAR] Auto-restarting in ${this.config.RESTART_DELAY}ms...`);
        setTimeout(() => {
          this.isStarting = false;
          this.start(dbPath).catch(err => {
            console.error('[SIDECAR] Failed to restart:', err);
            this.emit('restart-failed', err);
          });
        }, this.config.RESTART_DELAY);
      } else {
        this.isStarting = false;
      }
    });
  }

  stop(): void {
    console.log('[SIDECAR] Stopping sidecar process...');
    this.shouldRestart = false;

    if (this.process) {
      try {
        this.process.kill('SIGTERM');
        setTimeout(() => {
          if (this.process) {
            console.warn('[SIDECAR] Force killing sidecar');
            this.process.kill('SIGKILL');
          }
        }, this.config.SHUTDOWN_TIMEOUT);
      } catch (error) {
        console.error('[SIDECAR] Error killing process:', error);
      }
    }

    this.socketPath = null;
    this.pid = null;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.process) {
      this.process.kill(signal);
    }
  }

  enableAutoRestart(): void {
    this.shouldRestart = true;
  }

  disableAutoRestart(): void {
    this.shouldRestart = false;
  }

  getStatus(): { running: boolean; pid: number | null; socketPath: string | null; isStarting: boolean; shouldRestart: boolean } {
    return {
      running: this.process !== null,
      pid: this.pid,
      socketPath: this.socketPath,
      isStarting: this.isStarting,
      shouldRestart: this.shouldRestart,
    };
  }
}
