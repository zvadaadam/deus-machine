import { mkdir, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
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

export async function seedBoard(host, { dir, workspace, database }) {
  const context = path.join(dir, ".deus", "remote", ".context");
  await mkdir(context, { recursive: true });
  await writeFile(path.join(context, "report.md"), "# Release verification\n");
  const subject = crypto.randomUUID();
  const db = new Database(database, { fileMustExist: true });
  db.prepare(
    `INSERT INTO workspaces (id, repository_id, slug, title, state)
    SELECT ?, repository_id, 'report-check', 'Report check', 'ready' FROM workspaces WHERE id = ?`
  ).run(subject, workspace);
  db.close();
  const worker = path.join(dir, ".deus", "report-check", ".context");
  await mkdir(worker, { recursive: true });
  await writeFile(path.join(worker, "report.md"), "# Paired device results\n");
  const mac = await connectBackend(host.url);
  try {
    await mac.write("createSession", { workspaceId: subject });
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
