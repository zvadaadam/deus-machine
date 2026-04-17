// Manual WS smoke test — assumes `bun run dev` is already listening on 3100.
// Connects to /ws, triggers a REST tool call, asserts corresponding
// tool-event frames arrive. Exits 0 on success, 1 on failure.

const ws = new WebSocket("ws://127.0.0.1:3100/ws");
const seen: any[] = [];
let done = false;

function finish(code: number, message?: string): void {
  if (done) return;
  done = true;
  if (message) console.log(message);
  ws.close();
  process.exit(code);
}

ws.addEventListener("open", async () => {
  console.log("WS open");
  const res = await fetch("http://127.0.0.1:3100/api/tools/get_state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  console.log("REST status:", res.status);
});

ws.addEventListener("message", (e) => {
  const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
  seen.push(msg);
  console.log("WS msg:", JSON.stringify(msg));
  const completed = seen.filter(
    (m) => m.type === "tool-event" && m.status === "completed" && m.tool === "get_state"
  );
  if (completed.length > 0) {
    finish(0, `OK — saw ${seen.length} events, got tool-event(completed) for get_state`);
  }
});

ws.addEventListener("error", (e) => {
  console.error("WS error:", e);
  finish(1);
});

setTimeout(() => {
  finish(1, `FAIL — timeout after ${seen.length} events`);
}, 5000);
