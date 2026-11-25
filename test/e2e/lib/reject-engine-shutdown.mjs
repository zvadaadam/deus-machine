import { mock } from "node:test";
import { AgentRuntime } from "@zvada/agent-server/core";

const shutdown = AgentRuntime.prototype.shutdown;
mock.method(AgentRuntime.prototype, "shutdown", async function (...args) {
  await shutdown.apply(this, args);
  throw new Error("fixture engine rejection");
});
