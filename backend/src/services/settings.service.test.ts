import { vi } from 'vitest';

const mockStmt = {
  all: vi.fn(() => []),
  get: vi.fn(),
  run: vi.fn(),
};
const mockDb = {
  prepare: vi.fn(() => mockStmt),
};

vi.mock('../lib/database', () => ({
  getDatabase: vi.fn(() => mockDb),
}));

import { getAllSettings, saveSetting } from './settings.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prepare.mockReturnValue(mockStmt);
});

describe('getAllSettings', () => {
  it('returns empty object when no rows exist', () => {
    mockStmt.all.mockReturnValue([]);
    const result = getAllSettings();
    expect(result).toEqual({});
  });

  it('parses JSON values correctly', () => {
    mockStmt.all.mockReturnValue([
      { key: 'theme', value: '"dark"' },
      { key: 'count', value: '42' },
    ]);
    const result = getAllSettings();
    expect(result).toEqual({ theme: 'dark', count: 42 });
  });

  it('falls back to raw string for non-JSON values', () => {
    mockStmt.all.mockReturnValue([
      { key: 'raw', value: 'not-json' },
    ]);
    const result = getAllSettings();
    expect(result).toEqual({ raw: 'not-json' });
  });

  it('handles mixed JSON and non-JSON values', () => {
    mockStmt.all.mockReturnValue([
      { key: 'valid', value: '{"nested": true}' },
      { key: 'invalid', value: '{broken json' },
    ]);
    const result = getAllSettings();
    expect(result.valid).toEqual({ nested: true });
    expect(result.invalid).toBe('{broken json');
  });
});

describe('saveSetting', () => {
  it('calls db.prepare().run() with serialized value', () => {
    saveSetting('theme', 'dark');
    expect(mockDb.prepare).toHaveBeenCalled();
    expect(mockStmt.run).toHaveBeenCalledWith('theme', '"dark"');
  });

  it('serializes objects as JSON', () => {
    saveSetting('config', { enabled: true, count: 5 });
    expect(mockStmt.run).toHaveBeenCalledWith('config', '{"enabled":true,"count":5}');
  });

  it('serializes numbers as JSON', () => {
    saveSetting('count', 42);
    expect(mockStmt.run).toHaveBeenCalledWith('count', '42');
  });

  it('serializes boolean values as JSON', () => {
    saveSetting('flag', true);
    expect(mockStmt.run).toHaveBeenCalledWith('flag', 'true');
  });

  it('uses INSERT ... ON CONFLICT for upsert behavior', () => {
    saveSetting('key', 'value');
    const sqlArg = mockDb.prepare.mock.calls[0][0];
    expect(sqlArg).toContain('INSERT INTO settings');
    expect(sqlArg).toContain('ON CONFLICT(key) DO UPDATE');
  });
});
