import { vi, describe, it, expect } from 'vitest';
import { generateUniqueCityName, CITY_NAMES } from '../../services/workspace.service';

function createMockDb(existingNames: string[] = []) {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(() => existingNames.map(name => ({ directory_name: name }))),
    })),
  };
}

describe('CITY_NAMES', () => {
  it('is a non-empty array of strings', () => {
    expect(Array.isArray(CITY_NAMES)).toBe(true);
    expect(CITY_NAMES.length).toBeGreaterThan(0);
    CITY_NAMES.forEach(name => {
      expect(typeof name).toBe('string');
    });
  });
});

describe('generateUniqueCityName', () => {
  it('returns a string from CITY_NAMES when no existing workspaces', () => {
    const mockDb = createMockDb([]);
    const result = generateUniqueCityName(mockDb as any);

    expect(typeof result).toBe('string');
    expect(CITY_NAMES).toContain(result);
  });

  it('returns a name not already in use', () => {
    const taken = ['tokyo', 'delhi', 'shanghai'];
    const mockDb = createMockDb(taken);
    const result = generateUniqueCityName(mockDb as any);

    expect(taken).not.toContain(result);
    expect(typeof result).toBe('string');
  });

  it('queries the database for existing workspace directory names', () => {
    const mockDb = createMockDb([]);
    generateUniqueCityName(mockDb as any);

    expect(mockDb.prepare).toHaveBeenCalledWith('SELECT directory_name FROM workspaces');
  });

  it('falls back to versioned name when all cities are taken', () => {
    const mockDb = createMockDb([...CITY_NAMES]);
    const result = generateUniqueCityName(mockDb as any);

    // When all base city names are taken, the function tries versioned names
    // which contain '-v' (e.g., 'tokyo-v42')
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // It should either be a versioned name or a timestamp fallback
    const isVersioned = result.includes('-v');
    const isTimestamp = result.startsWith('workspace-');
    expect(isVersioned || isTimestamp).toBe(true);
  });

  it('falls back to timestamp-based name when everything else fails', () => {
    // Create a mock that includes all CITY_NAMES and many versioned variants
    // to exhaust both the random city and versioned name loops
    const allPossibleNames: string[] = [...CITY_NAMES];
    for (const city of CITY_NAMES) {
      for (let v = 0; v < 100; v++) {
        allPossibleNames.push(`${city}-v${v}`);
      }
    }
    const mockDb = createMockDb(allPossibleNames);
    const result = generateUniqueCityName(mockDb as any);

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
      results.add(generateUniqueCityName(mockDb as any));
    }
    expect(results.size).toBeGreaterThanOrEqual(2);
  });
});
