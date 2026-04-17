#!/usr/bin/env bun
/**
 * Verifies that holding mouse-down for >1s via /sim-input is interpreted
 * as a long-press (not a rapid tap) by sending `begin`, sleeping, then
 * `end` on the same coordinates. We don't assert the exact resulting
 * UI change — different screens react differently to long-press — but
 * we do assert the screen changes from the baseline, which is enough
 * to say the touch lifecycle reached the HID layer correctly.
 */

const PORT = Number(process.env.PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;

function frame(type: "begin" | "move" | "end", x: number, y: number): Uint8Array {
  const p = new TextEncoder().encode(JSON.stringify({ type, x, y }));
  const b = new Uint8Array(1 + p.length);
  b[0] = 0x03;
  b.set(p, 1);
  return b;
}

async function snapshot(): Promise<{ foreground: string | null; refs: number }> {
  const res = await fetch(`${BASE}/api/tools/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interactiveOnly: true, format: "compact" }),
  });
  const j = (await res.json()) as {
    success: boolean;
    result?: { foreground: string | null; refs: unknown[] };
  };
  if (!j.success) throw new Error("snapshot failed");
  return { foreground: j.result?.foreground ?? null, refs: j.result?.refs.length ?? 0 };
}

async function main(): Promise<void> {
  const pre = await snapshot();
  console.log(`pre:  foreground=${pre.foreground} refs=${pre.refs}`);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sim-input`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((r, j) => {
    ws.addEventListener("open", () => r());
    ws.addEventListener("error", () => j(new Error("ws error")));
    setTimeout(() => j(new Error("ws open timeout")), 3000);
  });

  // Long-press near an app icon (iOS home screen middle-top area).
  const x = 0.3;
  const y = 0.25;
  console.log(`hold: begin at (${x}, ${y}) → sleep 1500ms → end`);
  ws.send(frame("begin", x, y));
  await new Promise((r) => setTimeout(r, 1500));
  ws.send(frame("end", x, y));
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();

  const post = await snapshot();
  console.log(`post: foreground=${post.foreground} refs=${post.refs}`);

  const changed = pre.foreground !== post.foreground || pre.refs !== post.refs;
  if (changed) {
    console.log("\n✅ long-press delivered — screen changed");
    process.exit(0);
  } else {
    console.log("\n⚠  screen unchanged — could be empty area, or long-press lost");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
