const WebSocket = require("ws");

const DEFAULT_REQUIRED_AGENTS = ["claude", "codex-sdk", "codex-server"];
const JSON_RPC_TIMEOUT_MS = 5_000;

function requestJsonRpc(listenUrl, method, params) {
  return new Promise((resolve, reject) => {
    const id = `runtime-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ws = new WebSocket(listenUrl);
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // Ignore close races in smoke cleanup.
      }
      if (error) reject(error);
      else resolve(value);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for ${method} response from ${listenUrl}`));
    }, JSON_RPC_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

    ws.on("message", (data) => {
      let payload;
      try {
        payload = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (payload.id !== id) return;
      if (payload.error) {
        finish(new Error(`${method} failed: ${JSON.stringify(payload.error)}`));
        return;
      }
      finish(null, payload.result);
    });

    ws.on("error", (error) => {
      finish(error);
    });

    ws.on("close", () => {
      if (!settled) finish(new Error(`WebSocket closed before ${method} response`));
    });
  });
}

async function assertInitializedAgents(listenUrl, requiredAgents = DEFAULT_REQUIRED_AGENTS) {
  const result = await requestJsonRpc(listenUrl, "agent/list", {});
  const agents = Array.isArray(result?.agents) ? result.agents : [];
  const initialized = new Set(
    agents
      .filter((agent) => agent && agent.initialized === true && typeof agent.type === "string")
      .map((agent) => agent.type)
  );
  const missing = requiredAgents.filter((agent) => !initialized.has(agent));
  if (missing.length > 0) {
    throw new Error(
      `Agent-server did not report initialized bundled agents: missing=${missing.join(
        ", "
      )} result=${JSON.stringify(result)}`
    );
  }
  return agents;
}

function readAgentServerListenUrl(output) {
  return output.match(/(?:^|\n)(?:\[[^\]\n]+\] )*LISTEN_URL=(ws:\/\/[^\s]+)/)?.[1] ?? null;
}

module.exports = {
  assertInitializedAgents,
  readAgentServerListenUrl,
};
