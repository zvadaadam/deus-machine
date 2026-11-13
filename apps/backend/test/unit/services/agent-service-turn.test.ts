/**
 * Turn admission at the service layer — the local mirror and its rollback.
 *
 * `startTurn` registers the turn LOCALLY before the wire answers, on purpose:
 * the server may push the first envelopes in the same tick it acks, so the
 * event handler has to already know which turn is live. That optimism needs an
 * undo. When the wire REFUSES admission, the mirror is describing a turn that
 * will never run, and the session would sit holding a phantom turn id that the
 * next envelope folds into. `abortTurn` is what keeps the local view honest.
 *
 * The rollback is also load-bearing one layer up: sendMessage now awaits
 * admission and rethrows the refusal so the write's answer says
 * it was refused. A rollback that did not happen here would leave the
 * backend believing a turn is live for a send the frontend has already rolled
 * back — see agent-commands-send.test.ts for that half.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WireRequestError } from "@zvada/agent-server/client";
import { WIRE_ERROR_CODES } from "@zvada/agent-server/protocol";

const {
  mockOpen,
  mockLinkStartTurn,
  mockBeginTurn,
  mockAbortTurn,
  mockGetDatabase,
  mockInvalidate,
} = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockLinkStartTurn: vi.fn(),
  mockBeginTurn: vi.fn(),
  mockAbortTurn: vi.fn(),
  mockGetDatabase: vi.fn(),
  mockInvalidate: vi.fn(),
}));

vi.mock("../../../src/lib/database", () => ({
  getDatabase: mockGetDatabase,
  DB_PATH: "/tmp/deus-service-turn-test.db",
}));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: mockInvalidate }));
vi.mock("../../../src/services/agent/client", () => ({
  AgentLink: { open: mockOpen },
}));
vi.mock("../../../src/services/agent/event-handler", () => ({
  createAgentEventHandler: () => ({
    beginTurn: mockBeginTurn,
    abortTurn: mockAbortTurn,
    confirmTurn: vi.fn(),
    settleEventGap: vi.fn(),
    handle: vi.fn(),
    handleTitle: vi.fn(),
  }),
}));

import * as agentService from "../../../src/services/agent/service";

const SESSION = "sess-1";
const TURN = "turn-1";

const start = () =>
  agentService.startTurn(SESSION, TURN, "claude-code", "hello", { cwd: "/tmp/nonexistent-ws" });

describe("agentService.startTurn", () => {
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockOpen.mockResolvedValue({
      startTurn: mockLinkStartTurn,
      getAgents: () => [],
      isConnected: () => true,
      engine: { onAuthUpdated: () => () => {}, onCliProgress: () => () => {} },
      close: vi.fn().mockResolvedValue(undefined),
    });
    await agentService.init();
  });

  afterEach(async () => {
    await agentService.shutdown();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("rolls the local turn back when the wire refuses admission", async () => {
    mockBeginTurn.mockReturnValue(true);
    mockLinkStartTurn.mockRejectedValue(
      new WireRequestError(WIRE_ERROR_CODES.turnActive, "already has an active turn")
    );

    // Rethrown, not swallowed — this is the rejection sendMessage turns into
    // an `accepted: false` ack.
    await expect(start()).rejects.toBeInstanceOf(WireRequestError);

    expect(mockBeginTurn).toHaveBeenCalledWith(SESSION, TURN);
    expect(mockAbortTurn).toHaveBeenCalledWith(SESSION, TURN);
  });

  it("keeps the local turn when admission succeeds", async () => {
    mockBeginTurn.mockReturnValue(true);
    mockLinkStartTurn.mockResolvedValue({ sessionId: SESSION, turnId: TURN });

    await expect(start()).resolves.toBeUndefined();

    expect(mockAbortTurn).not.toHaveBeenCalled();
  });

  it("does NOT roll back a turn it never registered", async () => {
    // beginTurn said no: the session already holds a live turn locally. The
    // refusal that follows belongs to OUR doomed send, so rolling back here
    // would clear the OTHER turn's id and orphan its envelopes.
    mockBeginTurn.mockReturnValue(false);
    mockLinkStartTurn.mockRejectedValue(
      new WireRequestError(WIRE_ERROR_CODES.turnActive, "already has an active turn")
    );

    await expect(start()).rejects.toBeInstanceOf(WireRequestError);

    expect(mockAbortTurn).not.toHaveBeenCalled();
  });

  it("keeps a codex-sdk session's images: it runs on the app-server, which takes them", async () => {
    mockBeginTurn.mockReturnValue(true);
    mockLinkStartTurn.mockResolvedValue({ sessionId: SESSION, turnId: TURN });
    const link = (await mockOpen.mock.results[0]!.value) as { getAgents: () => unknown };
    link.getAgents = () => [{ type: "codex-app-server", capabilities: { images: true } }];
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
    await agentService.startTurn(SESSION, TURN, "codex-sdk", JSON.stringify([image]), {
      cwd: "/tmp/nonexistent-ws",
    });
    const params = mockLinkStartTurn.mock.calls[0]![0];
    expect(params.config.harness).toBe("codex-app-server");
    expect(params.input).toEqual([image]);
  });
});
