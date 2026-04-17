/**
 * Renders the HTML viewer that ships with `device-use stream enable`.
 *
 * Served as a file:// URL — the CLI writes this to a temp file so the browser
 * loads it without needing a second HTTP server. All network URLs inside the
 * HTML are absolute (pointing at the simbridge server on localhost:<port>)
 * because relative paths don't work from file:// origins.
 *
 * simbridge exposes:
 *   GET  /stream.mjpeg  — MJPEG keep-alive stream
 *   GET  /config        — { width, height } JSON (CORS-enabled)
 *   WS   /ws            — binary input channel (touch + button)
 */

export interface ViewerParams {
  port: number;
  width: number;
  height: number;
  host?: string; // default 'localhost'
}

export function renderViewerHtml(params: ViewerParams): string {
  const { port, width, height } = params;
  const host = params.host ?? "localhost";
  const httpOrigin = `http://${host}:${port}`;
  const wsOrigin = `ws://${host}:${port}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>device-use · Simulator Stream</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #111; color: #eee; font-family: system-ui, sans-serif;
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; min-height: 100vh; gap: 12px;
  }
  .container {
    position: relative; display: inline-block;
    border-radius: 12px; overflow: hidden;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5);
  }
  #stream {
    display: block; max-height: 85vh; width: auto;
    background: #222; cursor: pointer;
  }
  .status {
    font-size: 13px; color: #888; display: flex;
    align-items: center; gap: 8px;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #4a4; }
  .dot.disconnected { background: #a44; }
  #fps { font-variant-numeric: tabular-nums; }
  .controls { display: flex; gap: 8px; }
  .controls button {
    background: #333; color: #ccc; border: 1px solid #555;
    border-radius: 6px; padding: 6px 14px; cursor: pointer;
    font-size: 13px;
  }
  .controls button:hover { background: #444; }
  .meta { font-size: 11px; color: #555; }
</style>
</head>
<body>
<div class="container">
  <img id="stream" src="${httpOrigin}/stream.mjpeg" alt="Simulator">
</div>
<div class="status">
  <span class="dot" id="dot"></span>
  <span id="status-text">Connecting...</span>
  <span id="fps"></span>
</div>
<div class="controls">
  <button onclick="sendButton('home')">Home</button>
</div>
<div class="meta">${host}:${port}</div>

<script>
const WS_MSG_TOUCH = 0x03;
const WS_MSG_BUTTON = 0x04;
const STREAM_URL = ${JSON.stringify(`${httpOrigin}/stream.mjpeg`)};
const CONFIG_URL = ${JSON.stringify(`${httpOrigin}/config`)};
const WS_URL = ${JSON.stringify(`${wsOrigin}/ws`)};

let ws = null;
let screenW = ${width}, screenH = ${height};

function connect() {
  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    document.getElementById('dot').className = 'dot';
    document.getElementById('status-text').textContent = 'Connected';
  };
  ws.onclose = () => {
    document.getElementById('dot').className = 'dot disconnected';
    document.getElementById('status-text').textContent = 'Reconnecting...';
    setTimeout(connect, 2000);
  };
}

// Refresh screen config in case the simulator rotated
fetch(CONFIG_URL).then(r => r.json()).then(c => {
  if (c.width) screenW = c.width;
  if (c.height) screenH = c.height;
}).catch(() => {});

function sendTouch(type, e) {
  if (!ws || ws.readyState !== 1) return;
  const img = document.getElementById('stream');
  const rect = img.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
  const payload = JSON.stringify({ type, x, y });
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = WS_MSG_TOUCH;
  for (let i = 0; i < payload.length; i++) buf[i+1] = payload.charCodeAt(i);
  ws.send(buf.buffer);
}

function sendButton(button) {
  if (!ws || ws.readyState !== 1) return;
  const payload = JSON.stringify({ button });
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = WS_MSG_BUTTON;
  for (let i = 0; i < payload.length; i++) buf[i+1] = payload.charCodeAt(i);
  ws.send(buf.buffer);
}

const img = document.getElementById('stream');
let touching = false;

img.addEventListener('mousedown', (e) => {
  e.preventDefault(); touching = true;
  sendTouch('begin', e);
});
img.addEventListener('mousemove', (e) => {
  if (touching) sendTouch('move', e);
});
img.addEventListener('mouseup', (e) => {
  touching = false;
  sendTouch('end', e);
});
img.addEventListener('mouseleave', (e) => {
  if (touching) { touching = false; sendTouch('end', e); }
});
img.addEventListener('dragstart', (e) => e.preventDefault());

let frameCount = 0;
setInterval(() => {
  document.getElementById('fps').textContent = frameCount + ' fps';
  frameCount = 0;
}, 1000);

img.addEventListener('error', () => {
  document.getElementById('dot').className = 'dot disconnected';
  document.getElementById('status-text').textContent = 'Stream lost, reloading...';
  setTimeout(() => { img.src = STREAM_URL + '?' + Date.now(); }, 2000);
});
img.addEventListener('load', () => { frameCount++; });

connect();
</script>
</body>
</html>
`;
}
