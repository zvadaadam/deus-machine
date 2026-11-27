// This host uses the real relay, queue and board tools. Only its model is scripted.
import { existsSync } from "node:fs";
import path from "node:path";
import { DEUS_TOOLS_SERVER } from "../../../shared/mcp-servers.ts";
import { installScriptedChat } from "../lib/scripted-chat.mjs";
import { until } from "./stack.mjs";

const call = (tool, args) => ({ call: { server: DEUS_TOOLS_SERVER, tool, arguments: args } });
await installScriptedChat(async function* ({ input }) {
  if (input === "Open the remote release board") {
    yield call("create_board", { name: "Remote release" });
    yield call("post_to_board", { body: "The release candidate is ready for review." });
    yield call("post_to_board", { body: "The smoke checks passed on the fixture Mac." });
    yield call("post_to_board", { thread: 1, body: "The release notes are ready to check." });
  } else if (input === "Wait for the paired phone") {
    const marker = path.join(path.dirname(process.env.DATABASE_PATH), "release-coordinator");
    await until(() => existsSync(marker), 90_000, "the paired phone's queued reply");
  } else if (typeof input === "string" && input.endsWith("Which check comes next?")) {
    yield call("read_board", { thread: 1 });
    yield call("post_to_board", { body: "Please check the release notes on the phone." });
  }
  yield { end: true };
});
process.env.AGENT_ALLOW_AGENTLESS = "0";
await import("../../../apps/backend/src/server.ts");
