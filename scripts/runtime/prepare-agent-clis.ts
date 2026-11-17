import { prepareAgentClis } from "./agent-clis";

prepareAgentClis().catch((error) => {
  console.error("Agent CLI staging failed:", error);
  process.exit(1);
});
