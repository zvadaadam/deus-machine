import { vi, describe, it, expect } from 'vitest';
import { generateUniqueName, CELESTIAL_NAMES } from '../../../src/services/workspace.service';

function createMockDb(existingNames: string[] = []) {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(() => existingNames.map(name => ({ directory_name: name }))),
    })),
  };
}

describe('CELESTIAL_NAMES', () => {
  it('is a non-empty array of strings', () => {
    expect(Array.isArray(CELESTIAL_NAMES)).toBe(true);
    expect(CELESTIAL_NAMES.length).toBeGreaterThan(0);
    CELESTIAL_NAMES.forEach(name => {
      expect(typeof name).toBe('string');
    });
  });
});

describe('generateUniqueName', () => {
  it('returns a string from CELESTIAL_NAMES when no existing workspaces', () => {
    const mockDb = createMockDb([]);
    const result = generateUniqueName(mockDb as any);

    expect(typeof result).toBe('string');
    expect(CELESTIAL_NAMES).toContain(result);
  });

  it('returns a name not already in use', () => {
    const taken = ['europa', 'titan', 'sirius'];
    const mockDb = createMockDb(taken);
    const result = generateUniqueName(mockDb as any);

    expect(taken).not.toContain(result);
    expect(typeof result).toBe('string');
  });

  it('queries the database for existing workspace directory names', () => {
    const mockDb = createMockDb([]);
    generateUniqueName(mockDb as any);

    expect(mockDb.prepare).toHaveBeenCalledWith('SELECT directory_name FROM workspaces');
  });

  it('falls back to versioned name when all names are taken', () => {
    const mockDb = createMockDb([...CELESTIAL_NAMES]);
    const result = generateUniqueName(mockDb as any);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // It should either be a versioned name or a timestamp fallback
    const isVersioned = result.includes('-v');
    const isTimestamp = result.startsWith('workspace-');
    expect(isVersioned || isTimestamp).toBe(true);
  });

  it('falls back to timestamp-based name when everything else fails', () => {
    // Create a mock that includes all CELESTIAL_NAMES and many versioned variants
    // to exhaust both the random name and versioned name loops
    const allPossibleNames: string[] = [...CELESTIAL_NAMES];
    for (const name of CELESTIAL_NAMES) {
      for (let v = 0; v < 100; v++) {
        allPossibleNames.push(`${name}-v${v}`);
      }
    }
    const mockDb = createMockDb(allPossibleNames);
    const result = generateUniqueName(mockDb as any);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // With all names taken, it should fall back to timestamp
    expect(result.startsWith('workspace-')).toBe(true);
  });

  it('returns different names on subsequent calls (non-deterministic)', () => {
    const mockDb = createMockDb([]);
    const results = new Set<string>();
    // Run multiple times to verify randomness (at least 2 unique over 20 calls)
    for (let i = 0; i < 20; i++) {
      results.add(generateUniqueName(mockDb as any));
    }
    expect(results.size).toBeGreaterThanOrEqual(2);
  });
});
