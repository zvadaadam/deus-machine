import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import net from 'net';
import { SocketManager } from '../socket-manager';

const DEFAULT_CONFIG = {
  RECONNECT_INTERVAL: 1000,
  MAX_RECONNECT_INTERVAL: 30000,
  RECONNECT_BACKOFF: 1.5,
  MAX_RECONNECT_ATTEMPTS: 10,
};

/**
 * Creates a fake net.Socket that we can control in tests.
 * Emitting 'data' on this fake simulates the real socket receiving data.
 */
function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    connect: () => void;
  };
  socket.write = vi.fn();
  socket.destroy = vi.fn();
  return socket;
}

describe('SocketManager', () => {
  let manager: SocketManager;
  let fakeSocket: ReturnType<typeof createFakeSocket>;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeSocket = createFakeSocket();

    // Mock net.connect to return our fake socket and call the callback
    vi.spyOn(net, 'connect').mockImplementation((_path: any, cb: any) => {
      // Simulate async connection success
      if (cb) process.nextTick(cb);
      return fakeSocket as any;
    });

    manager = new SocketManager(DEFAULT_CONFIG);
  });

  afterEach(() => {
    manager.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('is not connected', () => {
      expect(manager.isConnected()).toBe(false);
    });

    it('returns correct initial status', () => {
      const status = manager.getStatus();
      expect(status).toEqual({
        connected: false,
        socketPath: null,
        isConnecting: false,
        reconnectAttempts: 0,
      });
    });
  });

  describe('connect', () => {
    it('skips connect when socket path is empty', () => {
      manager.connect('');
      expect(net.connect).not.toHaveBeenCalled();
    });

    it('calls net.connect with the socket path', () => {
      manager.connect('/tmp/test.sock');
      expect(net.connect).toHaveBeenCalledWith('/tmp/test.sock', expect.any(Function));
    });

    it('emits "connected" after successful connect', async () => {
      const connectedHandler = vi.fn();
      manager.on('connected', connectedHandler);

      manager.connect('/tmp/test.sock');
      // The connect callback fires on next tick
      await vi.advanceTimersByTimeAsync(0);

      expect(connectedHandler).toHaveBeenCalledTimes(1);
      expect(manager.isConnected()).toBe(true);
    });

    it('resets reconnect attempts on successful connect', async () => {
      manager.connect('/tmp/test.sock');
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.getStatus().reconnectAttempts).toBe(0);
    });

    it('skips connect when already connecting', () => {
      // Don't fire the callback so we stay in "connecting" state
      vi.mocked(net.connect).mockImplementation(() => fakeSocket as any);

      manager.connect('/tmp/test.sock');
      manager.connect('/tmp/test.sock');

      // net.connect should only be called once
      expect(net.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('NDJSON parsing via socket data events', () => {
    beforeEach(async () => {
      manager.connect('/tmp/test.sock');
      await vi.advanceTimersByTimeAsync(0);
    });

    it('parses a complete JSON line and emits message', () => {
      const messageHandler = vi.fn();
      manager.on('message', messageHandler);

      fakeSocket.emit('data', Buffer.from('{"type":"keep_alive","timestamp":123}\n'));

      expect(messageHandler).toHaveBeenCalledWith({
        type: 'keep_alive',
        timestamp: 123,
      });
    });

    it('handles multiple messages in one data chunk', () => {
      const messageHandler = vi.fn();
      manager.on('message', messageHandler);

      fakeSocket.emit('data', Buffer.from(
        '{"type":"keep_alive"}\n{"type":"result","session_id":"abc"}\n'
      ));

      expect(messageHandler).toHaveBeenCalledTimes(2);
      expect(messageHandler.mock.calls[0][0]).toEqual({ type: 'keep_alive' });
      expect(messageHandler.mock.calls[1][0]).toEqual({
        type: 'result',
        session_id: 'abc',
      });
    });

    it('buffers incomplete lines across multiple data events', () => {
      const messageHandler = vi.fn();
      manager.on('message', messageHandler);

      // First chunk: partial message
      fakeSocket.emit('data', Buffer.from('{"type":"ke'));
      expect(messageHandler).not.toHaveBeenCalled();

      // Second chunk: rest of message + newline
      fakeSocket.emit('data', Buffer.from('ep_alive"}\n'));
      expect(messageHandler).toHaveBeenCalledWith({ type: 'keep_alive' });
    });

    it('skips empty lines', () => {
      const messageHandler = vi.fn();
      manager.on('message', messageHandler);

      fakeSocket.emit('data', Buffer.from('\n\n{"type":"keep_alive"}\n\n'));

      expect(messageHandler).toHaveBeenCalledTimes(1);
    });

    it('emits parse-error for invalid JSON lines', () => {
      const errorHandler = vi.fn();
      manager.on('parse-error', errorHandler);

      fakeSocket.emit('data', Buffer.from('not-valid-json\n'));

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler.mock.calls[0][0].line).toBe('not-valid-json');
    });

    it('continues parsing after an invalid line', () => {
      const messageHandler = vi.fn();
      const errorHandler = vi.fn();
      manager.on('message', messageHandler);
      manager.on('parse-error', errorHandler);

      fakeSocket.emit('data', Buffer.from('bad-line\n{"type":"good"}\n'));

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(messageHandler).toHaveBeenCalledWith({ type: 'good' });
    });
  });

  describe('send', () => {
    it('returns false when not connected', () => {
      const result = manager.send({ type: 'test' });
      expect(result).toBe(false);
    });

    it('writes NDJSON to the socket when connected', async () => {
      manager.connect('/tmp/test.sock');
      await vi.advanceTimersByTimeAsync(0);

      const result = manager.send({ type: 'test', data: 'hello' });

      expect(result).toBe(true);
      expect(fakeSocket.write).toHaveBeenCalledWith(
        '{"type":"test","data":"hello"}\n'
      );
    });
  });

  describe('disconnect', () => {
    it('resets all state', () => {
      manager.disconnect();

      const status = manager.getStatus();
      expect(status.connected).toBe(false);
      expect(status.socketPath).toBeNull();
      expect(status.isConnecting).toBe(false);
      expect(status.reconnectAttempts).toBe(0);
    });

    it('destroys the socket', async () => {
      manager.connect('/tmp/test.sock');
      await vi.advanceTimersByTimeAsync(0);

      manager.disconnect();
      expect(fakeSocket.destroy).toHaveBeenCalled();
    });

    it('is safe to call multiple times', () => {
      expect(() => {
        manager.disconnect();
        manager.disconnect();
      }).not.toThrow();
    });
  });

  describe('reconnection on socket error', () => {
    it('schedules reconnect on socket error', async () => {
      manager.connect('/tmp/test.sock');
      await vi.advanceTimersByTimeAsync(0);

      // Simulate socket error
      fakeSocket.emit('error', new Error('ECONNRESET'));

      // After reconnect interval, should try to connect again
      vi.advanceTimersByTime(DEFAULT_CONFIG.RECONNECT_INTERVAL);
      // Original call + 1 reconnect attempt
      expect(net.connect).toHaveBeenCalledTimes(2);
    });

    it('schedules reconnect on socket close after was connected', async () => {
      manager.connect('/tmp/test.sock');
      await vi.advanceTimersByTimeAsync(0);

      // Simulate socket close
      fakeSocket.emit('close');

      vi.advanceTimersByTime(DEFAULT_CONFIG.RECONNECT_INTERVAL);
      expect(net.connect).toHaveBeenCalledTimes(2);
    });

    it('emits max-reconnects-exceeded after too many failures', async () => {
      const maxHandler = vi.fn();
      manager.on('max-reconnects-exceeded', maxHandler);

      // Make connect always fail with error
      vi.mocked(net.connect).mockImplementation((_path: any) => {
        const sock = createFakeSocket();
        process.nextTick(() => sock.emit('error', new Error('ECONNREFUSED')));
        return sock as any;
      });

      manager.connect('/tmp/test.sock');

      // Advance through all reconnect attempts
      for (let i = 0; i <= DEFAULT_CONFIG.MAX_RECONNECT_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.MAX_RECONNECT_INTERVAL);
      }

      expect(maxHandler).toHaveBeenCalled();
    });
  });

  describe('reconnection backoff', () => {
    it('increases reconnect interval with backoff multiplier', async () => {
      // Make connect fail on first two attempts to observe backoff
      let callCount = 0;
      vi.mocked(net.connect).mockImplementation((_path: any) => {
        callCount++;
        const sock = createFakeSocket();
        if (callCount <= 2) {
          process.nextTick(() => sock.emit('error', new Error('fail')));
        }
        return sock as any;
      });

      manager.connect('/tmp/test.sock');
      await vi.advanceTimersByTimeAsync(0);

      // First reconnect at 1000ms (RECONNECT_INTERVAL)
      vi.advanceTimersByTime(999);
      expect(callCount).toBe(1);
      vi.advanceTimersByTime(1);
      expect(callCount).toBe(2);
      await vi.advanceTimersByTimeAsync(0); // flush error → schedule backoff timer

      // Second reconnect at 1500ms (1000 × 1.5 RECONNECT_BACKOFF)
      vi.advanceTimersByTime(1499);
      expect(callCount).toBe(2);
      vi.advanceTimersByTime(1);
      expect(callCount).toBe(3);
    });
  });
});
