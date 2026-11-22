// The backend runs the agent engine in its own process and, once its client
// has initialized the engine, says which harnesses it registered:
//   [AgentService] Engine started, agents: [claude-code, codex-app-server, gemini]
// (before it prints [BACKEND_PORT]).

const { LOCAL_HARNESSES } = require("../../../shared/harnesses.ts");
const ENGINE_STARTED = /\[AgentService\] Engine started, agents: \[([^\]\n]*)\]/;

function assertEngineStarted(output, requiredHarnesses = LOCAL_HARNESSES) {
  const match = output.match(ENGINE_STARTED);
  if (!match) throw new Error("Backend output did not say the agent engine started");
  const harnesses = match[1]
    .split(",")
    .map((harness) => harness.trim())
    .filter(Boolean);
  const missing = requiredHarnesses.filter((harness) => !harnesses.includes(harness));
  if (missing.length > 0) {
    throw new Error(
      `The agent engine did not register: missing=${missing.join(", ")} registered=${harnesses.join(", ")}`
    );
  }
  return harnesses;
}

module.exports = { ENGINE_STARTED, assertEngineStarted };
