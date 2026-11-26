import { mkdir } from "node:fs/promises";
import path from "node:path";
import { connectBackend } from "../lib/operations.mjs";
import { until } from "./stack.mjs";

export function boardChatTurn(write, sessionId, content) {
  return write("sendMessage", {
    sessionId,
    content,
    agentHarness: "claude-code",
    model: "sonnet",
    permissionMode: "bypass_permissions",
  });
}

export async function seedBoard(host, { dir, workspace }) {
  await mkdir(path.join(dir, ".deus", "remote"), { recursive: true });
  const mac = await connectBackend(host.url);
  try {
    await mac.write("makeCoordinator", { workspaceId: workspace });
    const chat = await mac.write("createSession", { workspaceId: workspace });
    await mac.write("updateSessionTitle", { sessionId: chat.id, title: "Release room" });
    await boardChatTurn(mac.write, chat.id, "Open the remote release board");
    await until(
      async () => (await mac.read("boards"))[0]?.last_seq === 3,
      30_000,
      "the coordinator's two posts and thread reply"
    );
    return chat.id;
  } finally {
    mac.close();
  }
}
