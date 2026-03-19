import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const { mockExecFileSync, mockReaddirSync, mockStatSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('fs', () => ({
  default: {
    readdirSync: mockReaddirSync,
    statSync: mockStatSync,
    readFileSync: mockReadFileSync,
  },
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
  readFileSync: mockReadFileSync,
}));

import {
  scanWorkspaceFiles,
  readTextFile,
  fuzzySearchFiles,
  invalidateCache,
  clearCache,
} from '../../../src/services/files.service';

describe('files.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  afterEach(() => {
    clearCache();
  });

  describe('scanWorkspaceFiles (git mode)', () => {
    it('returns a tree from git ls-files output', () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse') return '.git';
        if (args[0] === 'ls-files') return 'src/app.ts\0src/index.ts\0README.md\0';
        return '';
      });
      mockStatSync.mockReturnValue({ size: 1024 });

      const result = scanWorkspaceFiles('/workspace');

      expect(result.totalFiles).toBe(3);
      expect(result.files).toHaveLength(2); // 'src' dir + README.md file

      const srcDir = result.files.find(n => n.name === 'src');
      expect(srcDir).toBeDefined();
      expect(srcDir!.type).toBe('directory');
      expect(srcDir!.children).toHaveLength(2);
      expect(srcDir!.children![0].name).toBe('app.ts');
      expect(srcDir!.children![1].name).toBe('index.ts');

      const readme = result.files.find(n => n.name === 'README.md');
      expect(readme).toBeDefined();
      expect(readme!.type).toBe('file');
      expect(readme!.size).toBe(1024);
    });

    it('sorts directories before files, both alphabetically', () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse') return '.git';
        if (args[0] === 'ls-files') return 'zebra.ts\0alpha.ts\0src/b.ts\0lib/a.ts\0';
        return '';
      });
      mockStatSync.mockReturnValue({ size: 100 });

      const result = scanWorkspaceFiles('/workspace');

      expect(result.files.map(n => n.name)).toEqual(['lib', 'src', 'alpha.ts', 'zebra.ts']);
    });

    it('caches results for 15 seconds', () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse') return '.git';
        if (args[0] === 'ls-files') return 'file.ts\0';
        return '';
      });
      mockStatSync.mockReturnValue({ size: 100 });

      const result1 = scanWorkspaceFiles('/workspace');
      const result2 = scanWorkspaceFiles('/workspace');

      // Second call should use cache — only 2 execFileSync calls total
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
      expect(result1).toBe(result2);
    });

    it('invalidates cache when requested', () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse') return '.git';
        if (args[0] === 'ls-files') return 'file.ts\0';
        return '';
      });
      mockStatSync.mockReturnValue({ size: 100 });

      scanWorkspaceFiles('/workspace');
      invalidateCache('/workspace');
      scanWorkspaceFiles('/workspace');

      expect(mockExecFileSync).toHaveBeenCalledTimes(4);
    });

    it('handles empty git repos', () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse') return '.git';
        if (args[0] === 'ls-files') return '';
        return '';
      });

      const result = scanWorkspaceFiles('/workspace');

      expect(result.files).toEqual([]);
      expect(result.totalFiles).toBe(0);
      expect(result.totalSize).toBe(0);
    });

    it('handles stat failures gracefully (deleted files)', () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse') return '.git';
        if (args[0] === 'ls-files') return 'exists.ts\0deleted.ts\0';
        return '';
      });
      mockStatSync.mockImplementation((filePath: string) => {
        if (filePath.includes('deleted.ts')) throw new Error('ENOENT');
        return { size: 500 };
      });

      const result = scanWorkspaceFiles('/workspace');

      expect(result.totalFiles).toBe(2);
      expect(result.totalSize).toBe(500);
    });

    it('builds nested directory trees correctly', () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse') return '.git';
        if (args[0] === 'ls-files') return 'src/features/auth/login.ts\0src/features/auth/types.ts\0src/app.ts\0';
        return '';
      });
      mockStatSync.mockReturnValue({ size: 100 });

      const result = scanWorkspaceFiles('/workspace');

      expect(result.totalFiles).toBe(3);
      const srcDir = result.files.find(n => n.name === 'src');
      expect(srcDir?.type).toBe('directory');

      const featuresDir = srcDir?.children?.find(n => n.name === 'features');
      expect(featuresDir?.type).toBe('directory');

      const authDir = featuresDir?.children?.find(n => n.name === 'auth');
      expect(authDir?.type).toBe('directory');
      expect(authDir?.children?.map(n => n.name)).toEqual(['login.ts', 'types.ts']);
    });
  });

  describe('scanWorkspaceFiles (readdir fallback)', () => {
    it('falls back to readdir when not a git repo', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not a git repository');
      });

      mockReaddirSync.mockImplementation((dir: string) => {
        if (dir === '/workspace') {
          return [
            { name: 'src', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
            { name: 'app.ts', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
            { name: 'node_modules', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          ];
        }
        if (dir.endsWith('/src')) {
          return [
            { name: 'index.ts', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          ];
        }
        return [];
      });
      mockStatSync.mockReturnValue({ size: 200 });

      const result = scanWorkspaceFiles('/workspace');

      expect(result.totalFiles).toBe(2);
      const nodeModules = result.files.find(n => n.name === 'node_modules');
      expect(nodeModules).toBeUndefined();
    });
  });

  describe('fuzzySearchFiles', () => {
    it('finds files matching a query', () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse') return '.git';
        if (args[0] === 'ls-files') return 'src/app.ts\0src/utils/helpers.ts\0README.md\0package.json\0';
        return '';
      });

      const results = fuzzySearchFiles('/workspace', 'app', 10);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toBe('src/app.ts');
      expect(results[0].name).toBe('app.ts');
    });

    it('respects limit parameter', () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse') return '.git';
        if (args[0] === 'ls-files') return 'a.ts\0b.ts\0c.ts\0d.ts\0e.ts\0';
        return '';
      });

      const results = fuzzySearchFiles('/workspace', 't', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty for non-matching query', () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse') return '.git';
        if (args[0] === 'ls-files') return 'src/app.ts\0';
        return '';
      });

      const results = fuzzySearchFiles('/workspace', 'zzzzz', 10);
      expect(results).toEqual([]);
    });
  });

  describe('readTextFile', () => {
    it('reads a text file', () => {
      mockReadFileSync.mockReturnValue(Buffer.from('hello world\n'));
      const content = readTextFile('/workspace/file.ts');
      expect(content).toBe('hello world\n');
    });

    it('returns null for binary files', () => {
      const binary = Buffer.alloc(100);
      binary[50] = 0;
      mockReadFileSync.mockReturnValue(binary);
      const content = readTextFile('/workspace/image.png');
      expect(content).toBeNull();
    });
  });
});
