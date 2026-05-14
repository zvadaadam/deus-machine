/**
 * Demo runner — spawns target + sandbox tunnel + desktop tunnel.
 *
 *   bun demo.ts
 *
 * Then open http://localhost:8080 in your browser.
 *
 * Topology:
 *
 *    browser → 127.0.0.1:8080  (desktop tunnel listener — run-desktop.ts)
 *               ↓ binary WebSocket frames
 *           127.0.0.1:9999     (sandbox tunnel handler   — run-sandbox.ts)
 *               ↓ TCP
 *           127.0.0.1:3000     (target dev server        — target.ts)
 *
 * In real life the dotted middle line crosses the public internet over HTTPS.
 * Here it's loopback. The CODE that runs at each box is the same.
 */

import { spawn, type Subprocess } from "bun";

const here = new URL(".", import.meta.url).pathname;

console.log("[demo] starting target on :3000…");
const target = spawn(["bun", "run", `${here}target.ts`], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, TARGET_PORT: "3000" },
});

console.log("[demo] starting sandbox tunnel handler on :9999…");
const sandbox = spawn(["bun", "run", `${here}run-sandbox.ts`], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, TUNNEL_PORT: "9999", TUNNEL_TOKEN: "secret-token" },
});

await Bun.sleep(500);

console.log("[demo] starting desktop tunnel listener on :8080…");
const desktop = spawn(["bun", "run", `${here}run-desktop.ts`], {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    LOCAL_PORT: "8080",
    REMOTE_PORT: "3000",
    TUNNEL_URL: "ws://127.0.0.1:9999",
    TUNNEL_TOKEN: "secret-token",
  },
});

await Bun.sleep(500);

console.log("");
console.log("─────────────────────────────────────────────────────────────");
console.log("  Open http://localhost:8080 in your browser.");
console.log("  Or curl:");
console.log("    curl http://localhost:8080/api/hello");
console.log("    curl http://localhost:8080/api/stream");
console.log("    curl -X POST -d 'hi' http://localhost:8080/api/echo");
console.log("");
console.log("  Ctrl-C to stop all three processes.");
console.log("─────────────────────────────────────────────────────────────");
console.log("");

const procs: Subprocess[] = [target, sandbox, desktop];

function killAll(reason: string) {
  console.log(`\n[demo] shutting down (${reason})`);
  for (const p of procs) {
    try {
      p.kill();
    } catch {}
  }
}

process.on("SIGINT", () => {
  killAll("SIGINT");
  process.exit(0);
});
process.on("SIGTERM", () => {
  killAll("SIGTERM");
  process.exit(0);
});

await Promise.race(procs.map((p) => p.exited));
killAll("child exited");
process.exit(1);
