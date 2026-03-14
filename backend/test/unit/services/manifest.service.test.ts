import { vi, describe, it, expect, beforeEach } from 'vitest';
import path from 'path';

// ─── Hoisted mocks (vi.mock factories run before imports) ─────────

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  createWriteStream: vi.fn(() => ({ end: vi.fn() })),
}));

vi.mock('fs', () => ({
  default: mockFs,
  existsSync: (...args: any[]) => mockFs.existsSync(...args),
  readFileSync: (...args: any[]) => mockFs.readFileSync(...args),
  writeFileSync: (...args: any[]) => mockFs.writeFileSync(...args),
  createWriteStream: (...args: any[]) => mockFs.createWriteStream(...args),
}));

// Mock spawn (used by runSetupScript, imported transitively)
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdout: { pipe: vi.fn() },
    stderr: { pipe: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  })),
}));

// Mock workspace-init.service (emitProgress is imported by manifest.service)
vi.mock('../../../src/services/workspace-init.service', () => ({
  emitProgress: vi.fn(),
}));

import { detectManifestFromProject } from '../../../src/services/manifest.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.existsSync.mockReturnValue(false);
  mockFs.readFileSync.mockReturnValue('{}');
});

// ─── Helper ───────────────────────────────────────────────────────

/**
 * Configure mockFs.existsSync to return true for paths ending with
 * any of the given filenames, and false otherwise.
 */
function filesExist(filenames: string[]): void {
  mockFs.existsSync.mockImplementation((p: unknown) => {
    const s = String(p);
    return filenames.some(f => s.endsWith(f));
  });
}

// ─── detectManifestFromProject ────────────────────────────────────

describe('detectManifestFromProject', () => {
  describe('Node.js projects', () => {
    it('detects bun as package manager when bun.lock exists', () => {
      filesExist(['package.json', 'bun.lock']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('package.json')) {
          return JSON.stringify({ scripts: { dev: 'vite', build: 'tsc && vite build' } });
        }
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'my-app');

      expect(manifest.name).toBe('my-app');
      expect(manifest.version).toBe(1);
      expect(manifest.lifecycle).toEqual({ setup: 'bun install' });
      expect(manifest.scripts).toEqual({ setup: 'bun install' });
      expect((manifest.requires as any).bun).toBe('>= 1.0');
      // bun doesn't require node
      expect((manifest.requires as any).node).toBeUndefined();
    });

    it('detects bun for bun.lockb (legacy binary lockfile)', () => {
      filesExist(['package.json', 'bun.lockb']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('package.json')) return JSON.stringify({});
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'my-app');

      expect(manifest.lifecycle).toEqual({ setup: 'bun install' });
      expect((manifest.requires as any).bun).toBe('>= 1.0');
    });

    it('detects yarn as package manager when yarn.lock exists', () => {
      filesExist(['package.json', 'yarn.lock']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('package.json')) return JSON.stringify({});
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'my-app');

      expect(manifest.lifecycle).toEqual({ setup: 'yarn install' });
      expect((manifest.requires as any).yarn).toBe('>= 1.0');
      expect((manifest.requires as any).node).toBe('>= 18');
    });

    it('detects pnpm as package manager when pnpm-lock.yaml exists', () => {
      filesExist(['package.json', 'pnpm-lock.yaml']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('package.json')) return JSON.stringify({});
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'my-app');

      expect(manifest.lifecycle).toEqual({ setup: 'pnpm install' });
      expect((manifest.requires as any).pnpm).toBe('>= 1.0');
      expect((manifest.requires as any).node).toBe('>= 18');
    });

    it('detects npm as package manager when package-lock.json exists', () => {
      filesExist(['package.json', 'package-lock.json']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('package.json')) return JSON.stringify({});
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'my-app');

      expect(manifest.lifecycle).toEqual({ setup: 'npm install' });
      expect((manifest.requires as any).npm).toBe('>= 1.0');
      expect((manifest.requires as any).node).toBe('>= 18');
    });

    it('falls back to npm when no lockfile exists', () => {
      filesExist(['package.json']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('package.json')) return JSON.stringify({});
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'my-app');

      expect(manifest.lifecycle).toEqual({ setup: 'npm install' });
      expect((manifest.requires as any).npm).toBe('>= 1.0');
    });

    it('detects dev script as persistent task', () => {
      filesExist(['package.json', 'bun.lock']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('package.json')) {
          return JSON.stringify({ scripts: { dev: 'vite' } });
        }
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'my-app');
      const tasks = manifest.tasks as Record<string, any>;

      expect(tasks.dev).toEqual({
        command: 'bun run dev',
        description: 'Start dev server',
        icon: 'play',
        persistent: true,
      });
    });

    it('detects build, test, lint, format, typecheck, start scripts', () => {
      filesExist(['package.json', 'bun.lock']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('package.json')) {
          return JSON.stringify({
            scripts: {
              build: 'tsc',
              test: 'vitest',
              lint: 'eslint .',
              format: 'prettier --write .',
              typecheck: 'tsc --noEmit',
              start: 'node dist/index.js',
            },
          });
        }
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'my-app');
      const tasks = manifest.tasks as Record<string, any>;

      expect(tasks.build.command).toBe('bun run build');
      expect(tasks.test.command).toBe('bun run test');
      expect(tasks.lint.command).toBe('bun run lint');
      expect(tasks.format.command).toBe('bun run format');
      expect(tasks.typecheck.command).toBe('bun run typecheck');
      expect(tasks.start.command).toBe('bun run start');
      expect(tasks.start.persistent).toBe(true);
    });

    it('uses "npm run" prefix for npm projects', () => {
      filesExist(['package.json']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('package.json')) {
          return JSON.stringify({ scripts: { build: 'tsc' } });
        }
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'my-app');
      const tasks = manifest.tasks as Record<string, any>;

      expect(tasks.build.command).toBe('npm run build');
    });
  });

  describe('Rust projects', () => {
    it('detects Cargo.toml and adds cargo tasks', () => {
      filesExist(['Cargo.toml']);

      const manifest = detectManifestFromProject('/project', 'rust-app');

      expect(manifest.lifecycle).toEqual({ setup: 'cargo build' });
      expect(manifest.scripts).toEqual({ setup: 'cargo build' });
      expect((manifest.requires as any).cargo).toBe('>= 1.0');

      const tasks = manifest.tasks as Record<string, any>;
      expect(tasks.build).toEqual({
        command: 'cargo build --release',
        description: 'Build release',
        icon: 'hammer',
      });
      expect(tasks.test).toEqual({
        command: 'cargo test',
        description: 'Run tests',
        icon: 'check-circle',
      });
      expect(tasks.clippy).toEqual({
        command: 'cargo clippy',
        description: 'Lint with Clippy',
        icon: 'search-code',
      });
    });
  });

  describe('Python projects', () => {
    it('detects pyproject.toml with pip install -e .', () => {
      filesExist(['pyproject.toml']);

      const manifest = detectManifestFromProject('/project', 'py-app');

      expect(manifest.lifecycle).toEqual({ setup: 'pip install -e .' });
      expect((manifest.requires as any).python).toBe('>= 3.10');

      const tasks = manifest.tasks as Record<string, any>;
      expect(tasks.test).toEqual({
        command: 'pytest',
        description: 'Run tests',
        icon: 'check-circle',
      });
    });

    it('detects requirements.txt with pip install -r', () => {
      filesExist(['requirements.txt']);

      const manifest = detectManifestFromProject('/project', 'py-app');

      expect(manifest.lifecycle).toEqual({ setup: 'pip install -r requirements.txt' });
    });

    it('uses uv pip when uv.lock exists', () => {
      filesExist(['pyproject.toml', 'uv.lock']);

      const manifest = detectManifestFromProject('/project', 'py-app');

      expect(manifest.lifecycle).toEqual({ setup: 'uv pip install -e .' });
    });

    it('uses uv pip install -r when requirements.txt + uv.lock', () => {
      filesExist(['requirements.txt', 'uv.lock']);

      const manifest = detectManifestFromProject('/project', 'py-app');

      expect(manifest.lifecycle).toEqual({ setup: 'uv pip install -r requirements.txt' });
    });
  });

  describe('Makefile projects', () => {
    it('detects Makefile targets as tasks', () => {
      filesExist(['Makefile']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('Makefile')) {
          return 'build:\n\tgo build ./...\ntest:\n\tgo test ./...\nclean:\n\trm -rf dist\n';
        }
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'go-app');
      const tasks = manifest.tasks as Record<string, any>;

      expect(tasks.build).toBe('make build');
      expect(tasks.test).toBe('make test');
      expect(tasks.clean).toBe('make clean');
    });

    it('skips .PHONY, all, and .DEFAULT targets', () => {
      filesExist(['Makefile']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('Makefile')) {
          return '.PHONY: build test\nall:\n\techo all\n.DEFAULT:\n\techo default\nbuild:\n\tgo build\n';
        }
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'go-app');
      const tasks = manifest.tasks as Record<string, any>;

      expect(tasks['.PHONY']).toBeUndefined();
      expect(tasks.all).toBeUndefined();
      expect(tasks['.DEFAULT']).toBeUndefined();
      expect(tasks.build).toBe('make build');
    });

    it('caps Makefile tasks at 8', () => {
      const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo-cmd', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
      filesExist(['Makefile']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('Makefile')) {
          return names.map(n => `${n}:\n\t@echo ${n}`).join('\n');
        }
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'go-app');
      const tasks = manifest.tasks as Record<string, any>;
      const taskKeys = Object.keys(tasks);

      expect(taskKeys.length).toBeLessThanOrEqual(8);
    });
  });

  describe('mixed projects', () => {
    it('detects both Node.js and Rust when package.json + Cargo.toml exist', () => {
      filesExist(['package.json', 'bun.lock', 'Cargo.toml']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('package.json')) {
          return JSON.stringify({ scripts: { dev: 'vite', build: 'tsc' } });
        }
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'tauri-app');
      const requires = manifest.requires as Record<string, string>;
      const tasks = manifest.tasks as Record<string, any>;

      // Node.js detected first, so setup is bun
      expect(manifest.lifecycle).toEqual({ setup: 'bun install' });
      expect(requires.bun).toBe('>= 1.0');
      expect(requires.cargo).toBe('>= 1.0');

      // Node.js tasks override Rust build/test, but clippy is unique to Rust
      expect(tasks.dev.command).toBe('bun run dev');
      expect(tasks.build.command).toBe('bun run build');
      expect(tasks.clippy.command).toBe('cargo clippy');
    });
  });

  describe('empty project', () => {
    it('returns minimal manifest with no tasks or requires', () => {
      mockFs.existsSync.mockReturnValue(false);

      const manifest = detectManifestFromProject('/project', 'empty-repo');

      expect(manifest).toEqual({ version: 1, name: 'empty-repo' });
      expect(manifest.tasks).toBeUndefined();
      expect(manifest.requires).toBeUndefined();
      expect(manifest.lifecycle).toBeUndefined();
    });
  });

  describe('invalid package.json', () => {
    it('skips Node.js detection when package.json is invalid JSON', () => {
      filesExist(['package.json']);
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('package.json')) return 'not valid json{{{';
        return '{}';
      });

      const manifest = detectManifestFromProject('/project', 'broken-app');

      // Should not crash, just skip Node.js detection
      expect(manifest.version).toBe(1);
      expect(manifest.name).toBe('broken-app');
    });
  });
});
