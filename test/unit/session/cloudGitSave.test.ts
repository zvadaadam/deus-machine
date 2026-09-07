import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { SessionSnapshotEventSchema } from "@deus-hq/api";
import { readCloudGitSave } from "@shared/cloud-git-save";
import type { Session } from "@shared/types/session";
import { CloudGitSaveNotice } from "@/features/session/ui/CloudGitSaveNotice";
import { makeCloudFrameHandler } from "@/features/session/cloud/cloudFrameHandler";
import { createStreamCursor } from "@/features/session/lib/agentEventFold";
import { queryKeys } from "@/shared/api/queryKeys";

const session: Session = {
  id: "s",
  workspace_id: "w",
  agent_harness: "claude-code",
  status: "idle",
  message_count: 2,
  context_token_count: 0,
  context_used_percent: 0,
  is_hidden: false,
  updated_at: "2026-09-07",
  workspace_kind: "cloud",
  provider_session_id: "s",
};
const failure = {
  committed: true,
  pushed: false,
  sha: "local-only",
  error: "GitHub rejected the backup",
};
const confirmed = { committed: false, pushed: false, sha: "confirmed-remote-sha" };
const receipt = (gitSync: unknown, timestamp = 100) => ({
  type: "turn.ended",
  sessionId: "s",
  turnId: `turn-${timestamp}`,
  stopReason: "end_turn",
  timestamp,
  gitSync,
});

describe("cloud Git backup receipts", () => {
  it("requires remote acknowledgment, independently of commit creation or agent success", () => {
    expect(readCloudGitSave(failure, 100)).toEqual({
      cloud_git_sync_at: 100,
      cloud_git_error: failure.error,
    });
    expect(readCloudGitSave({ ...failure, pushed: true }, 100)?.cloud_git_error).toBe(
      failure.error
    );
    expect(readCloudGitSave({ committed: true, pushed: false }, 100)).toBeUndefined();
    expect(readCloudGitSave(confirmed, 200)).toEqual({
      cloud_git_sync_at: 200,
      cloud_git_error: null,
    });
    expect(readCloudGitSave({ committed: true, pushed: true }, 200)?.cloud_git_error).toBeNull();
    expect(
      readCloudGitSave({ committed: false, pushed: false, conflict: true }, 200)?.cloud_git_error
    ).toContain("conflict");
  });

  it.each([undefined, {}, { pushed: "true", committed: false }, { error: 123 }])(
    "does not interpret a missing or malformed receipt as a save: %j",
    (value) => {
      expect(readCloudGitSave(value, 100)).toBeUndefined();
    }
  );

  it("does not accept an undated receipt", () => {
    expect(readCloudGitSave(confirmed, undefined)).toBeUndefined();
    expect(readCloudGitSave(confirmed, NaN)).toBeUndefined();
  });

  it("keeps the browser warning across reconnect and clears it only for a newer confirmation", () => {
    const queryClient = new QueryClient();
    const key = queryKeys.sessions.detail("s");
    queryClient.setQueryData(key, session);
    const onFrame = makeCloudFrameHandler(
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
    onFrame(receipt(failure));
    expect(queryClient.getQueryData(key)).toMatchObject({
      status: "idle",
      cloud_git_error: failure.error,
    });

    const snapshot = (turns: unknown[]) =>
      SessionSnapshotEventSchema.parse({
        type: "session.snapshot",
        state: { sessionId: "s", workspaceId: "w", organizationId: "o", status: "ready", turns },
        messages: [],
      });
    onFrame(snapshot([]));
    onFrame(receipt(undefined, 110));
    onFrame(receipt({ committed: true, pushed: false }, 120));
    onFrame(snapshot([{ turnId: "old", stopReason: "end_turn", endedAt: 50, gitSync: confirmed }]));
    expect(queryClient.getQueryData(key)).toMatchObject({
      cloud_git_sync_at: 100,
      cloud_git_error: failure.error,
    });

    onFrame(
      snapshot([{ turnId: "new", stopReason: "end_turn", endedAt: 200, gitSync: confirmed }])
    );
    onFrame(receipt(failure));
    expect(queryClient.getQueryData(key)).toMatchObject({
      cloud_git_sync_at: 200,
      cloud_git_error: null,
    });
    queryClient.clear();
  });

  it("restores a missed failure in a fresh browser from the published snapshot", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.sessions.detail("s"), session);
    const onFrame = makeCloudFrameHandler(
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
    onFrame(
      SessionSnapshotEventSchema.parse({
        type: "session.snapshot",
        state: {
          sessionId: "s",
          workspaceId: "w",
          organizationId: "o",
          status: "ready",
          turns: [{ turnId: "missed", stopReason: "end_turn", endedAt: 100, gitSync: failure }],
        },
        messages: [],
      })
    );
    const restored = queryClient.getQueryData<Session>(queryKeys.sessions.detail("s"))!;
    const markup = renderToStaticMarkup(createElement(CloudGitSaveNotice, { session: restored }));
    expect(markup).toContain("Git backup needs attention");
    expect(markup).toContain(failure.error);
    expect(markup).toContain("Draft a recovery request");
    expect(restored.status).toBe("idle");
    queryClient.clear();
  });

  it("distinguishes unknown from acknowledged backup status without claiming a full VM backup", () => {
    const render = (over: Partial<Session>) =>
      renderToStaticMarkup(createElement(CloudGitSaveNotice, { session: { ...session, ...over } }));
    expect(render({})).toContain("Git backup status is unavailable");
    expect(render({ message_count: 0 })).toBe("");
    expect(render({ cloud_git_sync_at: 100, cloud_git_error: null })).toBe("");
    expect(render({ status: "working", cloud_git_error: failure.error })).toContain(
      "Git backup needs attention"
    );
  });
});
