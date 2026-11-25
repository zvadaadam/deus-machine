// Preload in a Node backend to make a Codex turn ignore abort. The engine owns
// this real child, so the turn can settle only when its process tree is stopped.
import { once } from "node:events";
import { mock } from "node:test";
import { CodexAppServerAgent } from "@zvada/agent-server/core";

mock.method(CodexAppServerAgent.prototype, "execute", async function* (_input, { cwd, sessionId }) {
  const native = this.processes.spawn({
    harness: this.harness,
    sessionId,
    cwd,
    command: process.execPath,
    args: [
      "-e",
      'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 60_000)',
    ],
    env: {},
  });
  await once(native.child.stdout, "data");
  console.log(`[STUCK_AGENT_PID]${native.pid}`);
  yield* native.child.stdout; // The child stays silent and keeps the stream open until killed.
});
