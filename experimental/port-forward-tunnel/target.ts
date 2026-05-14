/**
 * Demo "dev server" — stands in for whatever app would be running inside the
 * cloud sandbox. Listens on 127.0.0.1:3000.
 *
 * Serves:
 *   GET /             — an HTML page with a button
 *   GET /api/hello    — JSON
 *   GET /api/stream   — slow chunked response (tests bidirectional flow)
 *
 * In the real Conductor scenario, this would be the user's `npm run dev`
 * process inside the sandbox container. Here it's just a friendly demo target.
 */

const startedAt = new Date().toISOString();
let requestCount = 0;

const server = Bun.serve({
  port: Number(process.env.TARGET_PORT ?? 3000),
  hostname: "127.0.0.1",

  async fetch(req) {
    const url = new URL(req.url);
    requestCount++;
    console.log(`[target] #${requestCount} ${req.method} ${url.pathname}`);

    if (url.pathname === "/api/hello") {
      return Response.json({
        message: "hello from the 'cloud' target",
        startedAt,
        requestCount,
        receivedAt: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/stream") {
      // Chunked response — proves bytes flow back through the tunnel in pieces.
      const stream = new ReadableStream({
        async start(controller) {
          for (let i = 0; i < 5; i++) {
            controller.enqueue(new TextEncoder().encode(`chunk ${i} at ${Date.now()}\n`));
            await Bun.sleep(300);
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/plain", "x-stream-marker": "chunked" },
      });
    }

    if (url.pathname === "/api/echo" && req.method === "POST") {
      // Echoes request body. Useful for testing client→server data flow.
      const body = await req.text();
      return Response.json({ youSent: body, length: body.length });
    }

    if (url.pathname === "/") {
      return new Response(
        `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Tunneled Target</title>
  <style>
    body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; padding: 2rem; max-width: 600px; }
    h1 { margin-top: 0; }
    button { padding: 0.5rem 1rem; margin: 0.5rem 0.5rem 0.5rem 0; font: inherit; cursor: pointer; }
    pre { background: #f4f4f4; padding: 1rem; border-radius: 4px; overflow-x: auto; }
    .meta { color: #888; font-size: 14px; }
  </style>
</head>
<body>
  <h1>I am running on 127.0.0.1:3000</h1>
  <p class="meta">
    You reached me through the WebSocket tunnel.<br>
    Started at ${startedAt}. Served ${requestCount} request(s).
  </p>

  <button id="hello">GET /api/hello</button>
  <button id="stream">GET /api/stream (chunked)</button>
  <button id="echo">POST /api/echo</button>

  <h3>Response</h3>
  <pre id="out">click a button</pre>

  <script>
    const out = document.getElementById("out");

    document.getElementById("hello").addEventListener("click", async () => {
      const r = await fetch("/api/hello");
      out.textContent = JSON.stringify(await r.json(), null, 2);
    });

    document.getElementById("stream").addEventListener("click", async () => {
      out.textContent = "";
      const r = await fetch("/api/stream");
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        out.textContent += decoder.decode(value, { stream: true });
      }
    });

    document.getElementById("echo").addEventListener("click", async () => {
      const r = await fetch("/api/echo", {
        method: "POST",
        body: "hello from the browser at " + new Date().toISOString(),
      });
      out.textContent = JSON.stringify(await r.json(), null, 2);
    });
  </script>
</body>
</html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[target] dev server listening on http://127.0.0.1:${server.port}`);
console.log(`[target] try: curl http://127.0.0.1:${server.port}/api/hello`);
