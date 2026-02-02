import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock all sub-modules before importing SidecarManager
vi.mock('../../lib/database', () => ({
  getDatabase: vi.fn(() => ({
    prepare: vi.fn(() => ({ run: vi.fn() })),
  })),
}));

vi.mock('../../lib/message-sanitizer', () => ({
  prepareMessageContent: vi.fn(() => ({ success: true, content: '{}' })),
}));

import { SidecarManager, CONFIG } from '../index';

describe('SidecarManager', () => {
  let manager: SidecarManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SidecarManager();
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('initializes all sub-managers', () => {
      expect(manager.processManager).toBeDefined();
      expect(manager.socketManager).toBeDefined();
      expect(manager.healthMonitor).toBeDefined();
    });
  });

  describe('event wiring', () => {
    it('connects socket when process emits "started"', () => {
      const connectSpy = vi.spyOn(manager.socketManager, 'connect');
      const socketPath = '/tmp/test-conductor.sock';

      manager.processManager.emit('started', { pid: 1234, socketPath });

      expect(connectSpy).toHaveBeenCalledWith(socketPath);
    });

    it('starts health monitor when socket connects', () => {
      const startSpy = vi.spyOn(manager.healthMonitor, 'start');

      manager.socketManager.emit('connected');

      expect(startSpy).toHaveBeenCalled();
    });

    it('stops health monitor when socket closes', () => {
      const stopSpy = vi.spyOn(manager.healthMonitor, 'stop');

      manager.socketManager.emit('closed');

      expect(stopSpy).toHaveBeenCalled();
    });

    it('updates keepalive on keep_alive messages', () => {
      const updateSpy = vi.spyOn(manager.healthMonitor, 'updateKeepalive');

      manager.socketManager.emit('message', { type: 'keep_alive', timestamp: Date.now() });

      expect(updateSpy).toHaveBeenCalled();
    });

    it('does not update keepalive for non-keepalive messages', () => {
      const updateSpy = vi.spyOn(manager.healthMonitor, 'updateKeepalive');

      manager.socketManager.emit('message', { type: 'init_status', success: true });

      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('kills process on unhealthy event when process is running', () => {
      const killSpy = vi.spyOn(manager.processManager, 'kill');
      vi.spyOn(manager.processManager, 'isRunning').mockReturnValue(true);

      manager.healthMonitor.emit('unhealthy', { timeSinceLastKeepalive: 65000 });

      expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    });

    it('does not kill process on unhealthy event when process is not running', () => {
      const killSpy = vi.spyOn(manager.processManager, 'kill');
      vi.spyOn(manager.processManager, 'isRunning').mockReturnValue(false);

      manager.healthMonitor.emit('unhealthy', { timeSinceLastKeepalive: 65000 });

      expect(killSpy).not.toHaveBeenCalled();
    });

    it('disconnects socket and stops health when process exits', () => {
      const disconnectSpy = vi.spyOn(manager.socketManager, 'disconnect');
      const stopSpy = vi.spyOn(manager.healthMonitor, 'stop');

      manager.processManager.emit('exit', { code: 0, signal: null });

      expect(disconnectSpy).toHaveBeenCalled();
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe('send', () => {
    it('delegates to socketManager.send', () => {
      const sendSpy = vi.spyOn(manager.socketManager, 'send').mockReturnValue(true);
      const message = { type: 'frontend_event', event: 'test' };

      const result = manager.send(message);

      expect(sendSpy).toHaveBeenCalledWith(message);
      expect(result).toBe(true);
    });

    it('returns false when socket is not connected', () => {
      const result = manager.send({ type: 'test' });
      expect(result).toBe(false);
    });
  });

  describe('stop', () => {
    it('stops all sub-managers', () => {
      const healthStopSpy = vi.spyOn(manager.healthMonitor, 'stop');
      const socketDisconnectSpy = vi.spyOn(manager.socketManager, 'disconnect');
      const processStopSpy = vi.spyOn(manager.processManager, 'stop');

      manager.stop();

      expect(healthStopSpy).toHaveBeenCalled();
      expect(socketDisconnectSpy).toHaveBeenCalled();
      expect(processStopSpy).toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('aggregates status from all sub-managers', () => {
      const status = manager.getStatus();

      // Should contain process manager fields
      expect(status).toHaveProperty('running');
      expect(status).toHaveProperty('pid');
      expect(status).toHaveProperty('shouldRestart');

      // Should contain socket manager fields
      expect(status).toHaveProperty('connected');
      expect(status).toHaveProperty('socketPath');
      expect(status).toHaveProperty('reconnectAttempts');

      // Should contain health monitor fields
      expect(status).toHaveProperty('isMonitoring');
      expect(status).toHaveProperty('lastKeepalive');
    });
  });

  describe('auto-restart control', () => {
    it('enables auto-restart via processManager', () => {
      const spy = vi.spyOn(manager.processManager, 'enableAutoRestart');
      manager.enableAutoRestart();
      expect(spy).toHaveBeenCalled();
    });

    it('disables auto-restart via processManager', () => {
      const spy = vi.spyOn(manager.processManager, 'disableAutoRestart');
      manager.disableAutoRestart();
      expect(spy).toHaveBeenCalled();
    });
  });
});

describe('CONFIG', () => {
  it('has expected reconnect settings', () => {
    expect(CONFIG.RECONNECT_INTERVAL).toBe(1000);
    expect(CONFIG.MAX_RECONNECT_INTERVAL).toBe(30000);
    expect(CONFIG.RECONNECT_BACKOFF).toBe(1.5);
    expect(CONFIG.MAX_RECONNECT_ATTEMPTS).toBe(10);
  });

  it('has expected keepalive settings', () => {
    expect(CONFIG.KEEPALIVE_INTERVAL).toBe(30000);
    expect(CONFIG.KEEPALIVE_TIMEOUT).toBe(60000);
  });

  it('has expected lifecycle settings', () => {
    expect(CONFIG.RESTART_DELAY).toBe(2000);
    expect(CONFIG.SHUTDOWN_TIMEOUT).toBe(5000);
  });
});
