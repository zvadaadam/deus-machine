import { vi } from "vitest";

export function createMockDb(overrides: Record<string, any> = {}) {
  const mockStmt = {
    all: vi.fn(() => []),
    get: vi.fn(() => undefined),
    run: vi.fn(() => ({ changes: 1 })),
  };
  return {
    prepare: vi.fn(() => mockStmt),
    exec: vi.fn(),
    pragma: vi.fn(),
    transaction: vi.fn((fn: Function) => fn),
    close: vi.fn(),
    _mockStmt: mockStmt,
    ...overrides,
  };
}

export function createMockWorkspace(overrides: Record<string, any> = {}) {
  return {
    id: "ws-test-001",
    repository_id: "repo-test-001",
    slug: "tokyo",
    git_branch: "workspace/tokyo",
    state: "ready",
    root_path: "/tmp/test-repo",
    git_default_branch: "main",
    git_target_branch: "main",
    current_session_id: "sess-test-001",
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

export function createMockSession(overrides: Record<string, any> = {}) {
  return {
    id: "sess-test-001",
    status: "idle",
    agent_harness: "claude",
    message_count: 0,
    context_token_count: 0,
    context_used_percent: 0,
    is_hidden: false,
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}
