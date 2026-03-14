import { promisify } from 'util';
import { execFile } from 'child_process';
import { getErrorMessage, isExecError } from '@shared/lib/errors';

const execFileAsync = promisify(execFile);

// Helper: run gh CLI command with timeout, explicit error classification
export async function runGh(args: string[], options: { cwd: string; timeoutMs?: number }): Promise<
  { success: true; stdout: string } | { success: false; error: 'gh_not_installed' | 'gh_not_authenticated' | 'timeout' | 'unknown'; message: string }
> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      cwd: options.cwd,
      encoding: 'utf-8',
      timeout: options.timeoutMs ?? 5000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    });
    return { success: true, stdout: stdout.trim() };
  } catch (err: unknown) {
    if (isExecError(err)) {
      if (err.code === 'ENOENT') return { success: false, error: 'gh_not_installed', message: 'GitHub CLI (gh) is not installed' };
      if (err.killed) return { success: false, error: 'timeout', message: 'GitHub CLI command timed out' };
      const output = `${err.stderr ?? ''} ${err.stdout ?? ''}`.toLowerCase();
      if (output.includes('gh auth login') || output.includes('not logged into any github hosts'))
        return { success: false, error: 'gh_not_authenticated', message: 'GitHub CLI is not authenticated' };
      return { success: false, error: 'unknown', message: err.stderr || err.message || 'Failed to run gh CLI' };
    }
    return { success: false, error: 'unknown', message: getErrorMessage(err) };
  }
}

// GitHub Check Suite conclusions that indicate a non-passing terminal state.
// Full GraphQL enum: ACTION_REQUIRED, CANCELLED, FAILURE, NEUTRAL, SKIPPED,
// STALE, STARTUP_FAILURE, SUCCESS, TIMED_OUT.
// NEUTRAL/SKIPPED are intentionally non-blocking (count as passing).
// STALE means re-run is needed (count as pending below).
export const FAILING_CONCLUSIONS = new Set([
  'FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'CANCELLED',
]);

// CheckRun `status` values that indicate the check hasn't completed yet.
// Note: CheckRun uses `status` field, StatusContext uses `state` field.
export const PENDING_STATUSES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

/**
 * Classify a single GitHub check (CheckRun or StatusContext) into a uniform status.
 * GitHub's statusCheckRollup contains two object types:
 *   - CheckRun (__typename: "CheckRun"): uses `conclusion` + `status`
 *   - StatusContext (__typename: "StatusContext"): uses `state`
 */
export function classifyCheck(check: any): 'passing' | 'failing' | 'pending' {
  if (check.__typename === 'StatusContext') {
    if (check.state === 'FAILURE' || check.state === 'ERROR') return 'failing';
    if (check.state === 'PENDING' || check.state === 'EXPECTED') return 'pending';
    return 'passing';
  }
  // CheckRun
  if (FAILING_CONCLUSIONS.has(check.conclusion)) return 'failing';
  if (check.conclusion === 'STALE' || check.conclusion == null || PENDING_STATUSES.has(check.status)) return 'pending';
  return 'passing';
}
