#!/usr/bin/env bun
/**
 * Drives /sim-input with a begin→end pair and verifies the sim reacts.
 * Takes a pre-snapshot, sends a normalized touch at (0.5, 0.7), takes a
 * post-snapshot. If the refs differ, the touch was injected successfully.
 */

const PORT = Number(process.env.PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;

function frame(type: "begin" | "move" | "end", x: number, y: number): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify({ type, x, y }));
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = 0x03;
  buf.set(payload, 1);
  return buf;
}

async function snapshotRefs(): Promise<string[]> {
  const res = await fetch(`${BASE}/api/tools/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: "json", interactiveOnly: true }),
  });
  const j = (await res.json()) as {
    success: boolean;
    result?: { refs: Array<{ ref: string; label?: string }> };
  };
  if (!j.success) throw new Error("snapshot failed");
  return (j.result?.refs ?? []).map((r) => `${r.ref}:${r.label ?? "?"}`);
}

async function main(): Promise<void> {
  console.log("== pre-snapshot ==");
  const pre = await snapshotRefs();
  console.log(`  ${pre.length} refs:`, pre.slice(0, 5).join(" / "));

  console.log("\n== opening /sim-input WS ==");
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sim-input`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), 3000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    });
  });
  console.log("  connected");

  // Tap near middle-bottom of the screen (0.5, 0.7) — where a button usually is.
  const x = 0.5;
  const y = 0.7;
  console.log(`\n== sending begin+end at (${x}, ${y}) ==`);
  ws.send(frame("begin", x, y));
  await new Promise((r) => setTimeout(r, 60));
  ws.send(frame("end", x, y));
  await new Promise((r) => setTimeout(r, 600));
  ws.close();

  console.log("\n== post-snapshot ==");
  const post = await snapshotRefs();
  console.log(`  ${post.length} refs:`, post.slice(0, 5).join(" / "));

  const same = pre.length === post.length && pre.every((r, i) => r === post[i]);
  if (same) {
    console.log("\n⚠  screen unchanged — touch may have hit empty area or wrong coords");
    process.exit(2);
  } else {
    console.log("\n✅ screen changed — touch was injected successfully");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
