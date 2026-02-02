import { describe, it, expect } from 'vitest';
import { canUseTool } from '../../services/claude.service';

describe('canUseTool - workspace path validation', () => {
  const workspacePath = '/Users/test/project/workspace';
  const sessionId = 'test-session';

  describe('ExitPlanMode', () => {
    it('always allows ExitPlanMode regardless of input', async () => {
      const result = await canUseTool(sessionId, 'ExitPlanMode', {}, workspacePath);
      expect(result.behavior).toBe('allow');
    });

    it('returns updatedInput for ExitPlanMode', async () => {
      const input = { some: 'data' };
      const result = await canUseTool(sessionId, 'ExitPlanMode', input, workspacePath);
      expect(result.updatedInput).toBe(input);
    });
  });

  describe('Edit tool', () => {
    it('allows editing files inside the workspace', async () => {
      const result = await canUseTool(sessionId, 'Edit', {
        file_path: '/Users/test/project/workspace/src/main.ts',
      }, workspacePath);
      expect(result.behavior).toBe('allow');
    });

    it('denies editing files outside the workspace', async () => {
      const result = await canUseTool(sessionId, 'Edit', {
        file_path: '/etc/passwd',
      }, workspacePath);
      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('Cannot edit files outside');
      expect(result.message).toContain('/etc/passwd');
    });

    it('denies editing files in a sibling directory', async () => {
      const result = await canUseTool(sessionId, 'Edit', {
        file_path: '/Users/test/project/other-workspace/file.ts',
      }, workspacePath);
      expect(result.behavior).toBe('deny');
    });

    it('denies path traversal via ../', async () => {
      const result = await canUseTool(sessionId, 'Edit', {
        file_path: '/Users/test/project/workspace/../../../etc/passwd',
      }, workspacePath);
      expect(result.behavior).toBe('deny');
    });

    it('allows editing at workspace root', async () => {
      const result = await canUseTool(sessionId, 'Edit', {
        file_path: '/Users/test/project/workspace/file.ts',
      }, workspacePath);
      expect(result.behavior).toBe('allow');
    });

    it('allows when no file_path is provided', async () => {
      const result = await canUseTool(sessionId, 'Edit', {}, workspacePath);
      expect(result.behavior).toBe('allow');
    });
  });

  describe('Write tool', () => {
    it('allows writing inside workspace', async () => {
      const result = await canUseTool(sessionId, 'Write', {
        file_path: '/Users/test/project/workspace/new-file.ts',
      }, workspacePath);
      expect(result.behavior).toBe('allow');
    });

    it('denies writing outside workspace', async () => {
      const result = await canUseTool(sessionId, 'Write', {
        file_path: '/tmp/malicious-file.sh',
      }, workspacePath);
      expect(result.behavior).toBe('deny');
    });
  });

  describe('MultiEdit tool', () => {
    it('denies multi-edit outside workspace', async () => {
      const result = await canUseTool(sessionId, 'MultiEdit', {
        file_path: '/Users/other/secret.txt',
      }, workspacePath);
      expect(result.behavior).toBe('deny');
    });
  });

  describe('NotebookEdit tool', () => {
    it('uses notebook_path for validation', async () => {
      const result = await canUseTool(sessionId, 'NotebookEdit', {
        notebook_path: '/Users/test/project/workspace/notebook.ipynb',
      }, workspacePath);
      expect(result.behavior).toBe('allow');
    });

    it('denies notebook editing outside workspace', async () => {
      const result = await canUseTool(sessionId, 'NotebookEdit', {
        notebook_path: '/tmp/evil-notebook.ipynb',
      }, workspacePath);
      expect(result.behavior).toBe('deny');
    });
  });

  describe('non-edit tools are not restricted', () => {
    it('allows Read tool without path check', async () => {
      const result = await canUseTool(sessionId, 'Read', {
        file_path: '/etc/hosts',
      }, workspacePath);
      expect(result.behavior).toBe('allow');
    });

    it('allows Bash tool without path check', async () => {
      const result = await canUseTool(sessionId, 'Bash', {
        command: 'ls /',
      }, workspacePath);
      expect(result.behavior).toBe('allow');
    });

    it('allows Grep tool without path check', async () => {
      const result = await canUseTool(sessionId, 'Grep', {
        pattern: 'password',
        path: '/etc',
      }, workspacePath);
      expect(result.behavior).toBe('allow');
    });
  });

  describe('edge cases', () => {
    it('allows edits when workspacePath is empty', async () => {
      const result = await canUseTool(sessionId, 'Edit', {
        file_path: '/some/path.ts',
      }, '');
      expect(result.behavior).toBe('allow');
    });

    it('prefix collision: workspace-other passes startsWith check', async () => {
      // Known issue: "/workspace-other" starts with "/workspace"
      // This documents current behavior - consider adding trailing slash check
      const result = await canUseTool(sessionId, 'Edit', {
        file_path: '/Users/test/project/workspace-other/file.ts',
      }, workspacePath);
      expect(result.behavior).toBe('allow');
    });
  });
});
