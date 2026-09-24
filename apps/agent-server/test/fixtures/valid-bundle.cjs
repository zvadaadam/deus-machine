// Stand-in for a fresh `dist/index.bundled.cjs`: passes the CLI's initialize
// handshake (protocolVersion: 2) then stays alive holding the WebSocket open.
// Used to put the CLI into its post-connect ("Connected") state so a bare
// SIGTERM to the parent can be exercised — the supervisor-kill orphan scope.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

fs.writeFileSync(path.join(__dirname, "valid-bundle.pid"), String(process.pid));

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
              protocolVersion: 2,
              server: { name: "valid-stub" },
              instanceId: "valid-1",
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
