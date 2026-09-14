import { beforeEach, expect, it, vi } from "vitest";
const { sendCommand } = vi.hoisted(() => ({ sendCommand: vi.fn() }));
vi.mock("@/platform/ws/query-protocol-client", () => ({ sendCommand }));
import { ptyCommands } from "@/platform/electron/commands/pty";

const options = {
  id: "terminal",
  command: "sh",
  args: [],
  cols: 80,
  rows: 24,
  cwd: "/workspace",
  cloudWorkspaceId: "cloud",
};
beforeEach(() => {
  sendCommand.mockReset();
});

it("surfaces rejected admission so Terminal can offer retry", async () => {
  sendCommand.mockResolvedValue({
    accepted: false,
    error: "Cloud workspace has no active session",
  });
  await expect(ptyCommands.spawn(options)).rejects.toThrow("Cloud workspace has no active session");
});

it("forwards cloud routing and resolves an accepted spawn", async () => {
  sendCommand.mockResolvedValue({ accepted: true });
  await expect(ptyCommands.spawn(options)).resolves.toBeUndefined();
  expect(sendCommand).toHaveBeenCalledWith("pty:spawn", options);
});

it("preserves transport errors", async () => {
  sendCommand.mockRejectedValue(new Error("Connection lost"));
  await expect(ptyCommands.spawn(options)).rejects.toThrow("Connection lost");
});
