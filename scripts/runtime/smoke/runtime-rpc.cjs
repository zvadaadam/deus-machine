const WebSocket = require("ws");

// Engine harness names on the standard @zvada/agent-server wire.
const DEFAULT_REQUIRED_HARNESSES = ["claude-code", "codex-sdk", "codex-app-server"];
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

async function assertInitializedAgents(listenUrl, requiredHarnesses = DEFAULT_REQUIRED_HARNESSES) {
  const result = await requestJsonRpc(listenUrl, "initialize", {
    // Must match the engine's WIRE_PROTOCOL_VERSION (this plain-node probe
    // cannot import the TS constant; the server rejects a mismatch loudly,
    // which is exactly how a stale value here surfaces).
    protocolVersion: 2,
    client: { name: "runtime-smoke" },
  });
  const harnesses =
    result?.harnesses && typeof result.harnesses === "object" ? Object.keys(result.harnesses) : [];
  const missing = requiredHarnesses.filter((harness) => !harnesses.includes(harness));
  if (missing.length > 0) {
    throw new Error(
      `Agent-server did not report available harnesses: missing=${missing.join(
        ", "
      )} result=${JSON.stringify(result)}`
    );
  }
  return harnesses;
}

function readAgentServerListenUrl(output) {
  return output.match(/(?:^|\n)(?:\[[^\]\n]+\] )*LISTEN_URL=(ws:\/\/[^\s]+)/)?.[1] ?? null;
}

module.exports = {
  assertInitializedAgents,
  readAgentServerListenUrl,
};
