// Stand-in for a stale `dist/index.bundled.cjs`: prints LISTEN_URL (so the CLI
// parses a url), accepts the WebSocket, and replies to `initialize` with a
// protocolVersion the CLI does not accept — exactly the stale-bundle handshake
// the agent-server CLI must not orphan. Mirrors index.ts's SIGINT/SIGTERM
// handlers so the orphan survives ONLY when no signal reaches the child, not
// because signals are ignored.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

// Record our PID so the lifecycle test can prove we were killed (not orphaned
// to PID 1) once the CLI exits.
fs.writeFileSync(path.join(__dirname, "stale-bundle.pid"), String(process.pid));

process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const server = http.createServer();
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    for (const line of data.toString().split("\n")) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method === "initialize" && msg.id !== undefined) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: 99,
              server: { name: "stale-stub" },
              instanceId: "stale-1",
              harnesses: {},
            },
          })
        );
      }
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("LISTEN_URL=ws://127.0.0.1:" + server.address().port + "\n");
});
