vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import {
  normalizeGitPath,
  splitGitDiffTokens,
  extractDiffInfo,
  resolveWorkspaceRelativePath,
  getOpenCommand,
  getDiffStats,
  getDiffFiles,
  getMergeBase,
  getGitFileContent,
  verifyBranchExists,
  detectDefaultBranch,
} from './git.service';

import {
  SIMPLE_MODIFY_DIFF,
  NEW_FILE_DIFF,
  DELETE_FILE_DIFF,
  RENAME_DIFF,
  QUOTED_PATH_DIFF,
  NUMSTAT_OUTPUT,
  SHORTSTAT_OUTPUT,
  SHORTSTAT_SINGLE,
} from '../test/fixtures/git-diffs';

const mockExecFileSync = vi.mocked(execFileSync);

describe('pure functions', () => {
  describe('normalizeGitPath', () => {
    it('strips a/ prefix', () => {
      expect(normalizeGitPath('a/src/app.ts')).toBe('src/app.ts');
    });

    it('strips b/ prefix', () => {
      expect(normalizeGitPath('b/src/app.ts')).toBe('src/app.ts');
    });

    it('strips surrounding quotes', () => {
      expect(normalizeGitPath('"a/path with spaces/file.ts"')).toBe('path with spaces/file.ts');
    });

    it('returns null for empty string', () => {
      expect(normalizeGitPath('')).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(normalizeGitPath(null as unknown as string)).toBeNull();
    });

    it('returns path unchanged when no prefix', () => {
      expect(normalizeGitPath('src/file.ts')).toBe('src/file.ts');
    });
  });

  describe('splitGitDiffTokens', () => {
    it('splits space-separated tokens', () => {
      expect(splitGitDiffTokens('a/file.ts b/file.ts')).toEqual(['a/file.ts', 'b/file.ts']);
    });

    it('handles quoted tokens', () => {
      expect(splitGitDiffTokens('"a/path with spaces/file.ts" "b/path with spaces/file.ts"')).toEqual([
        'a/path with spaces/file.ts',
        'b/path with spaces/file.ts',
      ]);
    });

    it('returns empty array for empty input', () => {
      expect(splitGitDiffTokens('')).toEqual([]);
    });

    it('limits to max 2 tokens', () => {
      const result = splitGitDiffTokens('a b c d');
      expect(result).toHaveLength(2);
    });
  });

  describe('extractDiffInfo', () => {
    it('parses a simple modify diff', () => {
      const info = extractDiffInfo(SIMPLE_MODIFY_DIFF);
      expect(info.oldPath).toBe('src/app.ts');
      expect(info.newPath).toBe('src/app.ts');
      expect(info.isNew).toBe(false);
      expect(info.isDeleted).toBe(false);
    });

    it('parses a new file diff', () => {
      const info = extractDiffInfo(NEW_FILE_DIFF);
      expect(info.newPath).toBe('src/new-file.ts');
      expect(info.isNew).toBe(true);
      expect(info.isDeleted).toBe(false);
    });

    it('parses a deleted file diff', () => {
      const info = extractDiffInfo(DELETE_FILE_DIFF);
      expect(info.oldPath).toBe('src/old-file.ts');
      expect(info.isDeleted).toBe(true);
    });

    it('parses a rename diff', () => {
      const info = extractDiffInfo(RENAME_DIFF);
      expect(info.oldPath).toBe('old-name.ts');
      expect(info.newPath).toBe('new-name.ts');
    });

    it('parses a diff with quoted paths', () => {
      const info = extractDiffInfo(QUOTED_PATH_DIFF);
      expect(info.oldPath).toBe('path with spaces/file.ts');
      expect(info.newPath).toBe('path with spaces/file.ts');
    });
  });

  describe('resolveWorkspaceRelativePath', () => {
    it('returns a safe relative path', () => {
      const result = resolveWorkspaceRelativePath('/workspace', 'src/file.ts');
      expect(result).toBe('src/file.ts');
    });

    it('returns null for path traversal attempts', () => {
      const result = resolveWorkspaceRelativePath('/workspace', '../../etc/passwd');
      expect(result).toBeNull();
    });

    it('returns null for absolute paths', () => {
      const result = resolveWorkspaceRelativePath('/workspace', '/etc/passwd');
      expect(result).toBeNull();
    });

    it('returns null for null-byte injection', () => {
      const result = resolveWorkspaceRelativePath('/workspace', 'file\0.ts');
      expect(result).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(resolveWorkspaceRelativePath('/workspace', '')).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(resolveWorkspaceRelativePath('/workspace', null as unknown as string)).toBeNull();
    });
  });

  describe('getOpenCommand', () => {
    it('returns platform-appropriate command', () => {
      const result = getOpenCommand('https://example.com');
      // Running on macOS in this environment
      if (process.platform === 'darwin') {
        expect(result).toEqual({ cmd: 'open', args: ['https://example.com'] });
      } else if (process.platform === 'win32') {
        expect(result).toEqual({ cmd: 'cmd', args: ['/c', 'start', '', 'https://example.com'] });
      } else {
        expect(result).toEqual({ cmd: 'xdg-open', args: ['https://example.com'] });
      }
    });

    it('passes the target through to args', () => {
      const result = getOpenCommand('/path/to/file');
      expect(result.args).toContain('/path/to/file');
    });
  });
});

describe('exec-dependent functions', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  describe('getDiffStats', () => {
    it('parses shortstat output correctly', () => {
      mockExecFileSync.mockReturnValue(SHORTSTAT_OUTPUT);
      const result = getDiffStats('/workspace', 'origin/main');
      expect(result).toEqual({ additions: 13, deletions: 20 });
    });

    it('returns zeros on error', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('git failed'); });
      const result = getDiffStats('/workspace', 'origin/main');
      expect(result).toEqual({ additions: 0, deletions: 0 });
    });

    it('parses single insertion shortstat', () => {
      mockExecFileSync.mockReturnValue(SHORTSTAT_SINGLE);
      const result = getDiffStats('/workspace', 'origin/main');
      expect(result).toEqual({ additions: 1, deletions: 0 });
    });
  });

  describe('getDiffFiles', () => {
    it('parses numstat output into file array', () => {
      mockExecFileSync.mockReturnValue(NUMSTAT_OUTPUT);
      const result = getDiffFiles('/workspace', 'origin/main');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ file: 'src/app.ts', additions: 10, deletions: 5 });
      expect(result[1]).toEqual({ file: 'src/new-file.ts', additions: 3, deletions: 0 });
      expect(result[2]).toEqual({ file: 'src/old-file.ts', additions: 0, deletions: 15 });
    });

    it('returns empty array on error', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('git failed'); });
      const result = getDiffFiles('/workspace', 'origin/main');
      expect(result).toEqual([]);
    });
  });

  describe('getMergeBase', () => {
    it('returns trimmed merge-base hash', () => {
      mockExecFileSync.mockReturnValue('abc123\n');
      const result = getMergeBase('/workspace', 'origin/main');
      expect(result).toBe('abc123');
    });

    it('returns parentBranch as fallback on error', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('git failed'); });
      const result = getMergeBase('/workspace', 'origin/main');
      expect(result).toBe('origin/main');
    });
  });

  describe('getGitFileContent', () => {
    it('returns file content on success', () => {
      mockExecFileSync.mockReturnValue('file content');
      const result = getGitFileContent('/workspace', 'HEAD', 'src/app.ts');
      expect(result).toBe('file content');
    });

    it('returns null on error', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('git failed'); });
      const result = getGitFileContent('/workspace', 'HEAD', 'src/app.ts');
      expect(result).toBeNull();
    });

    it('returns null for empty filePath', () => {
      const result = getGitFileContent('/workspace', 'HEAD', '');
      expect(result).toBeNull();
    });
  });

  describe('verifyBranchExists', () => {
    it('falls back through refs until one succeeds', () => {
      // First 2 calls throw (refs/heads/feature, refs/remotes/origin/feature),
      // 3rd call succeeds (refs/heads/main)
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('not found'); })
        .mockImplementationOnce(() => { throw new Error('not found'); })
        .mockImplementationOnce(() => undefined);
      const result = verifyBranchExists('/workspace', 'feature');
      expect(result).toBe('main');
    });

    it('returns the branch if first ref succeeds', () => {
      mockExecFileSync.mockReturnValue(undefined);
      const result = verifyBranchExists('/workspace', 'develop');
      expect(result).toBe('develop');
    });

    it('returns main when all checks fail', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
      const result = verifyBranchExists('/workspace', 'nonexistent');
      expect(result).toBe('main');
    });
  });

  describe('detectDefaultBranch', () => {
    it('uses origin HEAD strategy and verifies branch', () => {
      // First call: symbolic-ref returns origin/develop ref
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === 'symbolic-ref') {
          return 'refs/remotes/origin/develop';
        }
        // verifyBranchExists: first check (refs/heads/develop) succeeds
        if (args[0] === 'show-ref') {
          return undefined;
        }
        return '';
      });
      const result = detectDefaultBranch('/workspace');
      expect(result).toBe('develop');
    });

    it('falls back to main when all strategies fail', () => {
      // All exec calls throw
      mockExecFileSync.mockImplementation(() => { throw new Error('failed'); });
      const result = detectDefaultBranch('/workspace');
      expect(result).toBe('main');
    });
  });
});
