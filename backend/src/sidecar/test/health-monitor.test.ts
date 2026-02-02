import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HealthMonitor } from '../health-monitor';

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new HealthMonitor({ KEEPALIVE_TIMEOUT: 60000 });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  describe('start', () => {
    it('sets isMonitoring to true', () => {
      monitor.start();
      expect(monitor.getStatus().isMonitoring).toBe(true);
    });

    it('initializes lastKeepalive to current time', () => {
      const now = Date.now();
      monitor.start();
      expect(monitor.getStatus().lastKeepalive).toBe(now);
    });

    it('is idempotent - calling start twice does not reset state', () => {
      monitor.start();
      const firstKeepalive = monitor.getStatus().lastKeepalive;

      vi.advanceTimersByTime(5000);
      monitor.start(); // second call should be no-op

      expect(monitor.getStatus().lastKeepalive).toBe(firstKeepalive);
    });
  });

  describe('stop', () => {
    it('sets isMonitoring to false', () => {
      monitor.start();
      monitor.stop();
      expect(monitor.getStatus().isMonitoring).toBe(false);
    });

    it('clears lastKeepalive', () => {
      monitor.start();
      monitor.stop();
      expect(monitor.getStatus().lastKeepalive).toBeNull();
    });

    it('is safe to call when not monitoring', () => {
      expect(() => monitor.stop()).not.toThrow();
    });
  });

  describe('updateKeepalive', () => {
    it('updates the lastKeepalive timestamp', () => {
      monitor.start();
      vi.advanceTimersByTime(10000);
      monitor.updateKeepalive();

      const status = monitor.getStatus();
      expect(status.timeSinceKeepalive).toBeLessThanOrEqual(1);
    });
  });

  describe('health check interval', () => {
    it('emits "unhealthy" when keepalive timeout exceeded', () => {
      const unhealthyHandler = vi.fn();
      monitor.on('unhealthy', unhealthyHandler);

      monitor.start();
      // Advance past the 60s keepalive timeout + 15s check interval
      vi.advanceTimersByTime(75000);

      expect(unhealthyHandler).toHaveBeenCalled();
      expect(unhealthyHandler.mock.calls[0][0].timeSinceLastKeepalive).toBeGreaterThan(60000);
    });

    it('does not emit "unhealthy" when keepalive is fresh', () => {
      const unhealthyHandler = vi.fn();
      monitor.on('unhealthy', unhealthyHandler);

      monitor.start();
      // Advance 14s, update keepalive, advance another 14s
      vi.advanceTimersByTime(14000);
      monitor.updateKeepalive();
      vi.advanceTimersByTime(14000);

      expect(unhealthyHandler).not.toHaveBeenCalled();
    });

    it('does not emit "unhealthy" after stop', () => {
      const unhealthyHandler = vi.fn();
      monitor.on('unhealthy', unhealthyHandler);

      monitor.start();
      monitor.stop();
      vi.advanceTimersByTime(120000);

      expect(unhealthyHandler).not.toHaveBeenCalled();
    });

    it('fires health check every 15 seconds', () => {
      const unhealthyHandler = vi.fn();
      monitor.on('unhealthy', unhealthyHandler);

      monitor.start();
      // Advance to just before first check
      vi.advanceTimersByTime(14999);
      expect(unhealthyHandler).not.toHaveBeenCalled();

      // Advance past first check (15s) - keepalive is still fresh
      vi.advanceTimersByTime(1);
      expect(unhealthyHandler).not.toHaveBeenCalled();

      // Now advance to 75s total (past 60s timeout)
      vi.advanceTimersByTime(60000);
      expect(unhealthyHandler).toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('returns correct initial status', () => {
      const status = monitor.getStatus();
      expect(status).toEqual({
        isMonitoring: false,
        lastKeepalive: null,
        timeSinceKeepalive: null,
      });
    });

    it('returns timeSinceKeepalive when monitoring', () => {
      monitor.start();
      vi.advanceTimersByTime(5000);

      const status = monitor.getStatus();
      expect(status.timeSinceKeepalive).toBe(5000);
    });
  });
});
