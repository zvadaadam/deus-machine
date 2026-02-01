import net from 'net';
import { EventEmitter } from 'events';

interface SidecarConfig {
  RECONNECT_INTERVAL: number;
  MAX_RECONNECT_INTERVAL: number;
  RECONNECT_BACKOFF: number;
  MAX_RECONNECT_ATTEMPTS: number;
  [key: string]: any;
}

export class SocketManager extends EventEmitter {
  private config: SidecarConfig;
  private client: net.Socket | null = null;
  private socketPath: string | null = null;
  private isConnecting = false;
  private wasConnected = false;
  private reconnectAttempts = 0;
  private reconnectInterval: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private buffer = '';

  constructor(config: SidecarConfig) {
    super();
    this.config = config;
    this.reconnectInterval = config.RECONNECT_INTERVAL;
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  connect(socketPath: string): void {
    if (this.isConnecting) return;
    if (!socketPath) {
      console.warn('[SOCKET] Cannot connect: socket path not available');
      return;
    }

    this.socketPath = socketPath;
    this.isConnecting = true;

    try {
      this.client = net.connect(socketPath, () => {
        console.log('[SOCKET] Connected');
        this.isConnecting = false;
        this.wasConnected = true;
        this.reconnectAttempts = 0;
        this.reconnectInterval = this.config.RECONNECT_INTERVAL;
        this.emit('connected');
      });

      this.client.on('error', (err: Error) => {
        console.error('[SOCKET] Error:', err.message);
        this.isConnecting = false;
        this._scheduleReconnect();
      });

      this.client.on('close', () => {
        console.log('[SOCKET] Closed');
        const wasConnected = this.wasConnected;
        this.wasConnected = false;
        this.client = null;
        this.isConnecting = false;
        this.emit('closed');

        if (wasConnected && this.socketPath) {
          this._scheduleReconnect();
        }
      });

      this.client.on('data', (data: Buffer) => {
        this._handleData(data);
      });
    } catch (error: any) {
      console.error('[SOCKET] Failed to connect:', error.message);
      this.isConnecting = false;
      this._scheduleReconnect();
    }
  }

  private _handleData(data: Buffer): void {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        this.emit('message', message);
      } catch (error) {
        console.error('[SOCKET] Failed to parse message:', line.substring(0, 100), error);
        this.emit('parse-error', { line, error });
      }
    }
  }

  private _scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.reconnectAttempts >= this.config.MAX_RECONNECT_ATTEMPTS) {
      console.error('[SOCKET] Max reconnection attempts exceeded');
      this.emit('max-reconnects-exceeded');
      return;
    }

    this.reconnectAttempts++;
    console.log(`[SOCKET] Reconnecting in ${this.reconnectInterval}ms (attempt ${this.reconnectAttempts}/${this.config.MAX_RECONNECT_ATTEMPTS})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect(this.socketPath!);
      this.reconnectInterval = Math.min(
        this.reconnectInterval * this.config.RECONNECT_BACKOFF,
        this.config.MAX_RECONNECT_INTERVAL
      );
    }, this.reconnectInterval);
  }

  send(message: Record<string, any>): boolean {
    if (this.client && this.socketPath) {
      try {
        this.client.write(JSON.stringify(message) + '\n');
        return true;
      } catch (error) {
        console.error('[SOCKET] Failed to send message:', error);
        return false;
      }
    }
    console.warn('[SOCKET] Cannot send: not connected');
    return false;
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client) {
      try {
        this.client.destroy();
      } catch (error) {
        console.error('[SOCKET] Error closing socket:', error);
      }
      this.client = null;
    }

    this.socketPath = null;
    this.reconnectAttempts = 0;
    this.reconnectInterval = this.config.RECONNECT_INTERVAL;
    this.buffer = '';
  }

  getStatus(): { connected: boolean; socketPath: string | null; isConnecting: boolean; reconnectAttempts: number } {
    return {
      connected: this.client !== null,
      socketPath: this.socketPath,
      isConnecting: this.isConnecting,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}
