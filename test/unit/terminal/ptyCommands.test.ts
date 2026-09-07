import { beforeEach, describe, expect, it, vi } from "vitest";

// pty.ts is a thin wire adapter over the q:command protocol. Every method
// must produce exactly the frame the backend's ptyRouter dispatches on, and
// `spawn` must surface a refused ack (accepted:false) as a rejection — the
// sync-throw spawn path (cloud workspace with no current_session_id, or a
// missing local shell) emits no compensating pty-exit q:event, so the only
// failure signal the frontend has is the ack it inspects here.
const { sendCommand } = vi.hoisted(() => ({ sendCommand: vi.fn() }));
vi.mock("@/platform/ws/query-protocol-client", () => ({ sendCommand }));

import { ptyCommands } from "@/platform/electron/commands/pty";

beforeEach(() => {
  sendCommand.mockReset().mockResolvedValue({ accepted: true });
});

describe("ptyCommands — spawn (the arm that gates the dead-terminal signal)", () => {
  const opts = {
    id: "t1",
    command: "/bin/zsh",
    args: [],
    cols: 80,
    rows: 24,
    cwd: "/home/user",
  };

  it("issues pty:spawn with the full options payload and resolves on an accepted ack", async () => {
    await expect(ptyCommands.spawn(opts)).resolves.toBeUndefined();
    expect(sendCommand).toHaveBeenCalledExactlyOnceWith("pty:spawn", opts);
  });

  it("forwards cloudWorkspaceId when provided so the backend reroutes into the sandbox", async () => {
    await ptyCommands.spawn({ ...opts, cloudWorkspaceId: "ws-cloud" });
    expect(sendCommand).toHaveBeenLastCalledWith("pty:spawn", {
      ...opts,
      cloudWorkspaceId: "ws-cloud",
    });
  });

  it("omits cloudWorkspaceId when not provided (local spawn)", async () => {
    await ptyCommands.spawn(opts);
    expect(sendCommand).toHaveBeenLastCalledWith("pty:spawn", opts);
  });

  it("rejects with the backend's error when accepted:false carries one — Terminal.tsx's 'Failed to start terminal' catch fires", async () => {
    sendCommand.mockResolvedValueOnce({
      accepted: false,
      error: "Cloud workspace has no active session for a terminal",
    });
    await expect(ptyCommands.spawn(opts)).rejects.toThrow(
      "Cloud workspace has no active session for a terminal"
    );
  });

  it("rejects with a default message when accepted:false carries no error field", async () => {
    sendCommand.mockResolvedValueOnce({ accepted: false });
    await expect(ptyCommands.spawn(opts)).rejects.toThrow("pty:spawn failed");
  });

  it("propagates transport-level rejections (WS down / timeout) as rejections, not silent success", async () => {
    sendCommand.mockRejectedValueOnce(new Error("WebSocket not connected"));
    await expect(ptyCommands.spawn(opts)).rejects.toThrow("WebSocket not connected");
  });
});

describe("ptyCommands — write / resize / kill (fire-and-forget stream arms)", () => {
  it("write forwards { id, data } to pty:write and resolves regardless of the ack (consistency with the stream contract)", async () => {
    sendCommand.mockResolvedValueOnce({ accepted: false, error: "ignored" });
    await expect(ptyCommands.write("t1", [1, 2, 3])).resolves.toBeUndefined();
    expect(sendCommand).toHaveBeenLastCalledWith("pty:write", { id: "t1", data: [1, 2, 3] });
  });

  it("resize forwards { id, cols, rows } to pty:resize", async () => {
    await ptyCommands.resize("t1", 100, 40);
    expect(sendCommand).toHaveBeenLastCalledWith("pty:resize", { id: "t1", cols: 100, rows: 40 });
  });

  it("kill forwards { id } to pty:kill", async () => {
    await ptyCommands.kill("t1");
    expect(sendCommand).toHaveBeenLastCalledWith("pty:kill", { id: "t1" });
  });

  it("transport rejections still propagate for write/resize/kill (Terminal.tsx console.error fires)", async () => {
    sendCommand.mockRejectedValueOnce(new Error("Command pty:write timed out"));
    await expect(ptyCommands.write("t1", [1])).rejects.toThrow("Command pty:write timed out");
  });
});
