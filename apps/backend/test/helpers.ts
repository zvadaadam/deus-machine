import { vi, type Mock } from "vitest";
import type { AnyOp, InputOf, OutputOf } from "@shared/api/op";
import type { AnyStream, EventOf, ScopeOf } from "@shared/api/stream";
import { LOCAL_CALLER, Registry, type Caller, type Handler } from "../src/api/registry";
import type { PublishOptions } from "../src/services/streams";

/**
 * What a test's stand-in for `publish` (services/streams) was asked to send on
 * one stream, in order: the scope each event was published under (who receives
 * it), the event, and its options.
 *
 *   const mockPublish = vi.hoisted(() => vi.fn());
 *   vi.mock("../../../src/services/streams", () => ({ publish: mockPublish }));
 *   expect(published(mockPublish, toolRequests)).toEqual([{ scope, event }]);
 */
export function published<S extends AnyStream>(
  publish: Mock,
  stream: S
): { scope: ScopeOf<S>; event: EventOf<S>; options: PublishOptions | undefined }[] {
  return publish.mock.calls
    .filter(([sent]) => (sent as AnyStream).name === stream.name)
    .map(([, scope, event, options]) => ({ scope, event, options }));
}

/**
 * Call operations the way a client's frame does: by name, through validation,
 * to the handler. A refusal rejects with the `AppError` the client would be
 * told about (`statusCode`, `message`, `details`).
 */
export function operations(handlers: Handler[], caller: Caller = LOCAL_CALLER) {
  const registry = new Registry(handlers);
  return <O extends AnyOp>(op: O, input?: InputOf<O>): Promise<OutputOf<O>> =>
    registry.run(op.name, op.kind, input, { caller }) as Promise<OutputOf<O>>;
}

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
