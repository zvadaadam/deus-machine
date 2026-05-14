import { prepareAgentClis } from "./agent-clis";

prepareAgentClis({
  verifyRunnable: process.env.DEUS_VERIFY_AGENT_CLI_RUNNABLE === "1",
}).catch((error) => {
  console.error("Agent CLI staging failed:", error);
  process.exit(1);
});
