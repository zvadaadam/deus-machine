import { QueryClient } from "@tanstack/react-query";
import { SessionSnapshotEventSchema } from "@deus-hq/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCloudFrameHandler } from "@/features/session/cloud/cloudFrameHandler";
import { createStreamCursor } from "@/features/session/lib/agentEventFold";
import { queryKeys } from "@/shared/api/queryKeys";
import type { Session } from "@shared/types/session";

const { warning } = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: { warning, error: vi.fn() } }));

const session: Session = {
  id: "s",
  workspace_id: "w",
  agent_harness: "claude-code",
  status: "working",
  message_count: 2,
  context_token_count: 0,
  context_used_percent: 0,
  is_hidden: false,
  updated_at: "2026-09-07",
  workspace_kind: "cloud",
  provider_session_id: "s",
};
const failure = { committed: true, pushed: false, error: "GitHub rejected the push" };
let queryClient: QueryClient;
let onFrame: ReturnType<typeof makeCloudFrameHandler>;

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.sessions.detail("s"), session);
  onFrame = makeCloudFrameHandler(
    {
      queryClient,
      activeSessionId: "s",
      folds: new Map(),
      cursor: createStreamCursor(),
      scheduleFlush: () => {},
      requestRefetch: () => {},
    },
    "s"
  );
});

afterEach(() => queryClient.clear());

function endTurn(gitSync: unknown): void {
  onFrame({
    type: "turn.ended",
    sessionId: "s",
    turnId: "turn",
    timestamp: 100,
    stopReason: "end_turn",
    gitSync,
  });
}

describe("cloud autosave warning", () => {
  it("shows the provider diagnostic without turning a successful agent reply into an error", () => {
    endTurn({ ...failure, sha: "local-commit" });
    expect(warning).toHaveBeenCalledExactlyOnceWith("Cloud autosave failed", {
      description: failure.error,
      id: "cloud-autosave-s-turn",
      duration: 10_000,
      closeButton: true,
    });
    expect(queryClient.getQueryData(queryKeys.sessions.detail("s"))).toEqual({
      ...session,
      status: "idle",
    });
  });

  it("warns about a conflict even if the provider omitted its diagnostic", () => {
    endTurn({ committed: true, pushed: false, conflict: true });
    expect(warning).toHaveBeenCalledWith(
      "Cloud autosave failed",
      expect.objectContaining({
        description: "Git push hit a conflict with the remote repository.",
      })
    );
  });

  it.each([
    undefined,
    { committed: true, pushed: true, sha: "remote-commit" },
    { committed: false, pushed: false },
    { committed: false, pushed: false, sha: "confirmed-remote-commit" },
    { committed: true, pushed: "false", error: "Malformed receipt" },
  ])("does not warn for a successful, absent, or malformed result: %j", (receipt) => {
    endTurn(receipt);
    expect(warning).not.toHaveBeenCalled();
  });

  it("does not replay old warnings from reconnect snapshots", () => {
    onFrame(
      SessionSnapshotEventSchema.parse({
        type: "session.snapshot",
        state: {
          sessionId: "s",
          workspaceId: "w",
          organizationId: "o",
          status: "ready",
          turns: [{ turnId: "old", stopReason: "end_turn", endedAt: 100, gitSync: failure }],
        },
        messages: [],
      })
    );
    expect(warning).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.sessions.detail("s"))).toEqual({
      ...session,
      status: "idle",
      message_count: 0,
    });
  });
});
