/**
 * Unit tests for `query-engine.handleMutate`'s failure-frame contract.
 *
 * `handleMutate` resolves the q:mutate_result on the WS connection (mutations
 * do NOT reject over the wire). On failure it must:
 *   - set `success: false`
 *   - carry `error` (the thrown error's `.message`)
 *   - forward the structured `status` and `details` carried on the thrown
 *     Error (set by `delegateToRoute` on non-2xx) so frontend callers can
 *     recover from conflict-class errors (e.g. 409 "Repository already
 *     exists" with the existing `Repository` as `details`).
 *
 * Before the fix, `handleMutate` only sent `{ success, error }`, dropping both
 * structured fields — leaving the 409-recovery branch in `addRepoOrUseExisting`
 * dead.
 *
 * `sendFrame` writes through the registered WS connection, so this test uses
 * the real `addConnection`/`removeConnection` from `ws.service` with a fake
 * `ws.send` and asserts on the wire frame.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock `delegateToRoute` so the query-engine's `runMutation("addRepo", ...)`
// path throws/resolves without dispatching to a real Hono app. The mock is
// re-configured per-test via `mockImplementation`/`mockResolvedValue`.
//
// `vi.hoisted` keeps the mock reference available inside the (hoisted)
// `vi.mock` factory — vi.mock factories run before any top-level `const`.
const { delegateToRouteMock } = vi.hoisted(() => ({
  delegateToRouteMock: vi.fn(),
}));

vi.mock("../../../src/services/route-delegate", () => ({
  delegateToRoute: delegateToRouteMock,
}));

import { handleFrame } from "../../../src/services/query-engine";
import { addConnection, removeConnection } from "../../../src/services/ws.service";

const existingRepo = {
  id: "repo-existing",
  name: "existing-repo",
  root_path: "/tmp/existing-repo",
  git_default_branch: "main",
};

interface CapturedFrame {
  type: string;
  id: string;
  success?: boolean;
  error?: string;
  data?: unknown;
  status?: number;
  details?: unknown;
}

function makeFakeWs(): {
  ws: { send: (data: string) => void; close: () => void };
  frames: CapturedFrame[];
  nextFrame: Promise<CapturedFrame>;
} {
  const frames: CapturedFrame[] = [];
  let resolveNext: ((f: CapturedFrame) => void) | null = null;
  const nextFrame = new Promise<CapturedFrame>((r) => {
    resolveNext = r;
  });
  const ws = {
    send: (data: string) => {
      const frame = JSON.parse(data) as CapturedFrame;
      frames.push(frame);
      resolveNext?.(frame);
      resolveNext = null;
    },
    close: () => {},
  };
  return { ws, frames, nextFrame };
}

describe("handleMutate — q:mutate_result failure frame contract", () => {
  let connectionId: string;
  let fake: ReturnType<typeof makeFakeWs>;

  beforeEach(() => {
    delegateToRouteMock.mockReset();
    fake = makeFakeWs();
    connectionId = addConnection(fake.ws, null);
  });

  afterEach(() => {
    removeConnection(connectionId);
  });

  it("forwards `status` and `details` when the mutation throws a structured Error (409)", async () => {
    delegateToRouteMock.mockImplementation(() => {
      const err = new Error("Repository already exists") as Error & {
        status?: number;
        details?: unknown;
      };
      err.status = 409;
      err.details = existingRepo;
      throw err;
    });

    handleFrame(connectionId, {
      type: "q:mutate",
      id: "mut-409",
      action: "addRepo",
      params: { root_path: "/tmp/existing-repo" },
    });

    const frame = await fake.nextFrame;
    expect(frame.type).toBe("q:mutate_result");
    expect(frame.id).toBe("mut-409");
    expect(frame.success).toBe(false);
    expect(frame.error).toBe("Repository already exists");
    expect(frame.status).toBe(409);
    expect(frame.details).toEqual(existingRepo);
  });

  it("omits `status`/`details` when the thrown Error carries neither (plain Error)", async () => {
    delegateToRouteMock.mockImplementation(() => {
      throw new Error("Mutation failed for some unrelated reason");
    });

    handleFrame(connectionId, {
      type: "q:mutate",
      id: "mut-plain",
      action: "addRepo",
      params: { root_path: "/tmp/repo" },
    });

    const frame = await fake.nextFrame;
    expect(frame.type).toBe("q:mutate_result");
    expect(frame.id).toBe("mut-plain");
    expect(frame.success).toBe(false);
    expect(frame.error).toBe("Mutation failed for some unrelated reason");
    expect(frame.status).toBeUndefined();
    expect(frame.details).toBeUndefined();
  });

  it("forwards `details` with a non-number `status` omitted (defensive: only numeric status is trusted)", async () => {
    delegateToRouteMock.mockImplementation(() => {
      const err = new Error("Conflict-but-not-numeric") as Error & {
        status?: unknown;
        details?: unknown;
      };
      err.status = "409" as unknown as number; // a string sneaks in → must NOT be forwarded as-is
      err.details = { whatever: "shape" };
      throw err;
    });

    handleFrame(connectionId, {
      type: "q:mutate",
      id: "mut-string-status",
      action: "addRepo",
      params: { root_path: "/tmp/repo" },
    });

    const frame = await fake.nextFrame;
    expect(frame.success).toBe(false);
    expect(frame.status).toBeUndefined(); // non-number status is dropped
    expect(frame.details).toEqual({ whatever: "shape" });
  });

  it("sends `success: true` with `data` and no status/details when the mutation succeeds", async () => {
    const repo = {
      id: "repo-new",
      name: "new-repo",
      root_path: "/tmp/new-repo",
      git_default_branch: "main",
    };
    delegateToRouteMock.mockResolvedValue(repo);

    handleFrame(connectionId, {
      type: "q:mutate",
      id: "mut-ok",
      action: "addRepo",
      params: { root_path: "/tmp/new-repo" },
    });

    const frame = await fake.nextFrame;
    expect(frame.type).toBe("q:mutate_result");
    expect(frame.id).toBe("mut-ok");
    expect(frame.success).toBe(true);
    expect(frame.data).toEqual(repo);
    expect(frame.error).toBeUndefined();
    expect(frame.status).toBeUndefined();
    expect(frame.details).toBeUndefined();
  });

  it("rethrows-into-frame for a non-Error thrown value, using the generic 'Mutation failed' fallback", async () => {
    // Defensive: a non-Error throw (not produced by the real pipeline, but
    // guards against a regression where some upstream throws a plain object).
    delegateToRouteMock.mockImplementation(() => {
      // Plain object with .message and structured fields — NOT an Error.
      // `handleMutate` should use "Mutation failed" for the error string and
      // still forward numeric status/details.
      throw {
        message: "ignored-because-not-an-Error",
        status: 409,
        details: existingRepo,
      };
    });

    handleFrame(connectionId, {
      type: "q:mutate",
      id: "mut-non-err",
      action: "addRepo",
      params: { root_path: "/tmp/existing-repo" },
    });

    const frame = await fake.nextFrame;
    expect(frame.success).toBe(false);
    // err instanceof Error === false → "Mutation failed" fallback.
    expect(frame.error).toBe("Mutation failed");
    // status/details are read off the object regardless of Error-ness.
    expect(frame.status).toBe(409);
    expect(frame.details).toEqual(existingRepo);
  });
});
