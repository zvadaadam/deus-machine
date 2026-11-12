import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { RuntimeClient } from "@/platform/ws/runtime-client";

// What the Terminal's calls put on the wire, and how the host's answer comes back.
const client = new RuntimeClient(
  { host: "host", account: "account", grant: "grant" },
  {
    open: () => {
      throw new Error("No socket needed");
    },
  }
);
const sendMutate = vi.spyOn(client, "sendMutate");

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
  sendMutate.mockReset();
});
afterAll(() => client.dispose());

it("surfaces a refused spawn so Terminal can offer retry", async () => {
  sendMutate.mockResolvedValue({
    success: false,
    error: "Cloud workspace has no active session",
  });
  await expect(client.call(api.ptySpawn, options)).rejects.toThrow(
    "Cloud workspace has no active session"
  );
});

it("forwards cloud routing and resolves an accepted spawn with the terminal's id", async () => {
  sendMutate.mockResolvedValue({ success: true, data: { id: "terminal" } });
  await expect(client.call(api.ptySpawn, options)).resolves.toEqual({ id: "terminal" });
  expect(sendMutate).toHaveBeenCalledExactlyOnceWith("pty:spawn", options, undefined);
});

it("preserves transport errors", async () => {
  sendMutate.mockRejectedValue(new Error("Connection lost"));
  await expect(client.call(api.ptySpawn, options)).rejects.toThrow("Connection lost");
});

it("sends input as an array of byte values", async () => {
  sendMutate.mockResolvedValue({ success: true });
  await expect(
    client.call(api.ptyWrite, { id: "terminal", data: [108, 115, 13] })
  ).resolves.toBeUndefined();
  expect(sendMutate).toHaveBeenCalledExactlyOnceWith(
    "pty:write",
    { id: "terminal", data: [108, 115, 13] },
    undefined
  );
});
