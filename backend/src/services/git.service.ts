import { execFileSync } from 'child_process';
import path from 'path';

const parentBranchCache = new Map<string, { branch: string; expiresAt: number }>();
const PARENT_BRANCH_CACHE_TTL_MS = 5000;

export function verifyBranchExists(root_path: string, branch: string): string {
  const checks = [
    `refs/heads/${branch}`,
    `refs/remotes/origin/${branch}`,
    'refs/heads/main',
    'refs/heads/master',
  ];
  for (const ref of checks) {
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', ref], { cwd: root_path, timeout: 2000 });
      if (ref.endsWith('/main')) return 'main';
      if (ref.endsWith('/master')) return 'master';
      return branch;
    } catch {}
  }
  return 'main';
}

export function detectDefaultBranch(root_path: string): string {
  const strategies = [
    {
      name: 'origin HEAD',
      fn: () => {
        const output = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
          cwd: root_path, encoding: 'utf-8', timeout: 2000
        }).trim();
        return output.replace(/^refs\/remotes\/origin\//, '');
      }
    },
    {
      name: 'current branch',
      fn: () => execFileSync('git', ['branch', '--show-current'], {
        cwd: root_path, encoding: 'utf-8', timeout: 2000
      }).trim()
    },
    {
      name: 'default fallback',
      fn: () => 'main'
    }
  ];

  for (const strategy of strategies) {
    try {
      const branch = strategy.fn();
      if (branch) {
        return verifyBranchExists(root_path, branch);
      }
    } catch {}
  }

  return 'main';
}

export function resolveParentBranch(
  workspacePath: string,
  parentBranch: string | null,
  defaultBranch: string | null
): string {
  const cacheKey = `${workspacePath}::${parentBranch || ''}::${defaultBranch || ''}`;
  const cached = parentBranchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.branch;
  }

  const candidates = [parentBranch, defaultBranch, 'main', 'master', 'develop'].filter(Boolean) as string[];

  // Try remote branches first
  for (const branch of candidates) {
    const ref = branch.startsWith('origin/') ? branch : `origin/${branch}`;
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/remotes/${ref}`], {
        cwd: workspacePath, timeout: 2000
      });
      parentBranchCache.set(cacheKey, { branch: ref, expiresAt: Date.now() + PARENT_BRANCH_CACHE_TTL_MS });
      return ref;
    } catch {}
  }

  // Try local branches
  for (const branch of candidates) {
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: workspacePath, timeout: 2000
      });
      parentBranchCache.set(cacheKey, { branch, expiresAt: Date.now() + PARENT_BRANCH_CACHE_TTL_MS });
      return branch;
    } catch {}
  }

  const fallback = defaultBranch || 'main';
  parentBranchCache.set(cacheKey, { branch: fallback, expiresAt: Date.now() + PARENT_BRANCH_CACHE_TTL_MS });
  return fallback;
}

export function resolveWorkspaceRelativePath(workspacePath: string, filePath: string): string | null {
  if (!filePath || typeof filePath !== 'string') return null;
  if (filePath.includes('\0')) return null;

  const normalized = path.normalize(filePath);
  if (path.isAbsolute(normalized)) return null;

  const resolved = path.resolve(workspacePath, normalized);
  const relative = path.relative(workspacePath, resolved);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return relative;
}

export function normalizeGitPath(pathToken: string): string | null {
  if (!pathToken || typeof pathToken !== 'string') return null;
  let cleaned = pathToken.trim();
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1);
  }
  if (cleaned.startsWith('a/')) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('b/')) {
    cleaned = cleaned.slice(2);
  }
  return cleaned;
}

export function splitGitDiffTokens(value: string): string[] {
  if (!value) return [];
  const tokens: string[] = [];
  let i = 0;
  while (i < value.length && tokens.length < 2) {
    while (value[i] === ' ') i += 1;
    if (i >= value.length) break;
    if (value[i] === '"') {
      let end = i + 1;
      while (end < value.length && value[end] !== '"') end += 1;
      tokens.push(value.slice(i + 1, Math.min(end, value.length)));
      i = end + 1;
    } else {
      let end = i;
      while (end < value.length && value[end] !== ' ') end += 1;
      tokens.push(value.slice(i, end));
      i = end + 1;
    }
  }
  return tokens;
}

export interface DiffInfo {
  oldPath: string | null;
  newPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
}

export function extractDiffInfo(diffOutput: string): DiffInfo {
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let isNew = false;
  let isDeleted = false;

  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const tokens = splitGitDiffTokens(line.slice('diff --git '.length));
      if (tokens[0]) oldPath = normalizeGitPath(tokens[0]);
      if (tokens[1]) newPath = normalizeGitPath(tokens[1]);
      continue;
    }
    if (line.startsWith('rename from ')) {
      oldPath = normalizeGitPath(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      newPath = normalizeGitPath(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('new file mode')) { isNew = true; continue; }
    if (line.startsWith('deleted file mode')) { isDeleted = true; continue; }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const match = line.match(/^(---|\+\+\+)\s+([^\t\r\n]+)(.*)$/);
      if (!match) continue;
      const [, prefix, fileName] = match;
      if (fileName === '/dev/null') {
        if (prefix === '---') isNew = true;
        if (prefix === '+++') isDeleted = true;
        continue;
      }
      if (prefix === '---' && !oldPath) oldPath = normalizeGitPath(fileName);
      else if (prefix === '+++' && !newPath) newPath = normalizeGitPath(fileName);
    }
  }

  return { oldPath, newPath, isNew, isDeleted };
}

export function getGitFileContent(workspacePath: string, ref: string, filePath: string): string | null {
  if (!filePath) return null;
  try {
    return execFileSync('git', ['show', `${ref}:${filePath}`], {
      cwd: workspacePath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 5000
    }).toString();
  } catch {
    return null;
  }
}

export function getMergeBase(workspacePath: string, parentBranch: string): string {
  try {
    return execFileSync('git', ['merge-base', parentBranch, 'HEAD'], {
      cwd: workspacePath, encoding: 'utf-8', timeout: 5000
    }).toString().trim();
  } catch {
    return parentBranch;
  }
}

export function getDiffStats(workspacePath: string, parentBranch: string): { additions: number; deletions: number } {
  try {
    const output = execFileSync('git', ['diff', `${parentBranch}...HEAD`, '--shortstat'], {
      cwd: workspacePath, encoding: 'utf-8', timeout: 5000
    }).toString().trim();

    const additions = output.match(/(\d+)\s+insertion(?:s)?/)?.[1] || '0';
    const deletions = output.match(/(\d+)\s+deletion(?:s)?/)?.[1] || '0';
    return { additions: parseInt(additions, 10), deletions: parseInt(deletions, 10) };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

export function getDiffFiles(workspacePath: string, parentBranch: string): Array<{ file: string; additions: number; deletions: number }> {
  try {
    const output = execFileSync('git', ['diff', `${parentBranch}...HEAD`, '--numstat'], {
      cwd: workspacePath, encoding: 'utf-8', timeout: 5000
    }).toString().trim();

    if (!output) return [];

    return output.split('\n').map(line => {
      const [additions, deletions, file] = line.split('\t');
      return { file, additions: parseInt(additions, 10) || 0, deletions: parseInt(deletions, 10) || 0 };
    });
  } catch {
    return [];
  }
}

export function getFileDiff(workspacePath: string, parentBranch: string, filePath: string): string {
  return execFileSync('git', ['diff', `${parentBranch}...HEAD`, '--', filePath], {
    cwd: workspacePath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 5000
  }).toString();
}

export function getOpenCommand(target: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', target] };
  if (process.platform === 'darwin') return { cmd: 'open', args: [target] };
  return { cmd: 'xdg-open', args: [target] };
}
