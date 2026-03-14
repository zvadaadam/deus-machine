// backend/src/routes/gate.ts
// Serves a self-contained HTML pairing page at "/" for remote browser clients.
// After pairing, shows a live mini-dashboard of repos + workspaces.
// Desktop (Tauri) never hits this — it uses its own webview.

import { Hono } from "hono";
import { html } from "hono/html";

const app = new Hono();

app.get("/", (c) => {
  return c.html(gatePage());
});

function gatePage() {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenDevs</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #09090b; color: #fafafa;
      min-height: 100vh; padding: 16px;
    }

    /* ── Pairing View ── */
    .pair-view {
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
    }
    .pair-card { width: 100%; max-width: 380px; text-align: center; }
    h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
    .sub { color: #a1a1aa; font-size: 14px; margin-top: 8px; }
    form { margin-top: 32px; }
    label { display: block; text-align: left; font-size: 13px; font-weight: 500; margin-bottom: 8px; }
    .inputs { display: flex; align-items: center; gap: 8px; }
    .inputs input {
      flex: 1; padding: 12px; border-radius: 8px;
      border: 1px solid #27272a; background: #18181b; color: #fafafa;
      font-family: "SF Mono", "Fira Code", monospace; font-size: 18px;
      text-align: center; outline: none; letter-spacing: 0.1em;
    }
    .inputs input:focus { border-color: #3b82f6; }
    .inputs input::placeholder { color: #52525b; }
    .dash { color: #52525b; font-size: 20px; font-weight: 700; }
    .pair-btn {
      margin-top: 20px; width: 100%; padding: 12px;
      border-radius: 8px; border: none;
      background: #fafafa; color: #09090b;
      font-size: 14px; font-weight: 600; cursor: pointer;
      transition: opacity 0.2s;
    }
    .pair-btn:hover { opacity: 0.9; }
    .pair-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .error { color: #ef4444; font-size: 13px; margin-top: 12px; }
    .help { color: #71717a; font-size: 12px; margin-top: 32px; }

    /* ── Dashboard View ── */
    .dash-view { display: none; max-width: 640px; margin: 0 auto; padding: 32px 0; }
    .dash-view.show { display: block; }
    .dash-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 32px;
    }
    .dash-header h1 { font-size: 20px; }
    .dash-header .connected {
      display: flex; align-items: center; gap: 6px;
      color: #22c55e; font-size: 13px; font-weight: 500;
    }
    .connected-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #22c55e;
    }

    /* Repo group */
    .repo-group { margin-bottom: 24px; }
    .repo-name {
      font-size: 13px; font-weight: 600; color: #a1a1aa;
      text-transform: uppercase; letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    .ws-list { display: flex; flex-direction: column; gap: 6px; }
    .ws-card {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; border-radius: 8px;
      background: #18181b; border: 1px solid #27272a;
    }
    .ws-info { display: flex; flex-direction: column; gap: 2px; }
    .ws-name { font-size: 14px; font-weight: 500; }
    .ws-branch { font-size: 12px; color: #71717a; font-family: "SF Mono", monospace; }
    .ws-status {
      font-size: 11px; font-weight: 600; padding: 2px 8px;
      border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.04em;
      white-space: nowrap;
    }
    .ws-status.working { background: #422006; color: #fb923c; }
    .ws-status.idle { background: #1a2e05; color: #84cc16; }
    .ws-status.error { background: #450a0a; color: #f87171; }
    .ws-status.archived { background: #1c1917; color: #78716c; }
    .ws-status.initializing { background: #172554; color: #60a5fa; }

    .empty-state {
      text-align: center; color: #52525b; padding: 48px 16px;
      font-size: 14px;
    }
    .loading { text-align: center; color: #71717a; padding: 48px 16px; font-size: 14px; }
  </style>
</head>
<body>
  <!-- Pairing View -->
  <div id="pair-view" class="pair-view">
    <div class="pair-card">
      <h1>Connect to OpenDevs</h1>
      <p class="sub">Enter the pairing code from your desktop app.</p>

      <form id="pair-form">
        <label>Pairing Code</label>
        <div class="inputs">
          <input id="word" type="text" placeholder="WORD" autocomplete="off"
                 autocapitalize="characters" spellcheck="false" autofocus />
          <span class="dash">-</span>
          <input id="number" type="text" inputmode="numeric" placeholder="0000"
                 autocomplete="off" maxlength="4" />
        </div>
        <div id="error" class="error" style="display:none"></div>
        <button type="submit" id="btn" class="pair-btn" disabled>Connect</button>
      </form>

      <p class="help">Open Settings &gt; Remote Access in the OpenDevs desktop app to generate a code.</p>
    </div>
  </div>

  <!-- Dashboard View (shown after pairing) -->
  <div id="dash-view" class="dash-view">
    <div class="dash-header">
      <h1>OpenDevs</h1>
      <div class="connected">
        <span class="connected-dot"></span>
        <span id="dash-device">Connected</span>
      </div>
    </div>
    <div id="dash-content">
      <div class="loading">Loading workspaces...</div>
    </div>
  </div>

  <script>
    const wordEl = document.getElementById('word');
    const numEl = document.getElementById('number');
    const btn = document.getElementById('btn');
    const errorEl = document.getElementById('error');
    const form = document.getElementById('pair-form');
    const pairView = document.getElementById('pair-view');
    const dashView = document.getElementById('dash-view');

    // Check if already paired (token in localStorage)
    const existingToken = localStorage.getItem('opendevs_device_token');
    if (existingToken) {
      showDashboard(existingToken, null);
    }

    // Pre-fill from ?pair=WORD-NNNN
    const params = new URLSearchParams(location.search);
    const pair = params.get('pair');
    if (pair) {
      const m = pair.match(/^([A-Za-z]+)-(\\d{4})$/);
      if (m) { wordEl.value = m[1].toUpperCase(); numEl.value = m[2]; updateBtn(); }
    }

    wordEl.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase();
      errorEl.style.display = 'none';
      updateBtn();
    });

    wordEl.addEventListener('keydown', (e) => {
      if ((e.key === '-' || e.key === 'Tab') && wordEl.value.length >= 2) {
        e.preventDefault(); numEl.focus();
      }
    });

    numEl.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\\D/g, '').slice(0, 4);
      errorEl.style.display = 'none';
      updateBtn();
      if (e.target.value.length === 4 && wordEl.value.length >= 2) {
        submit();
      }
    });

    function updateBtn() {
      btn.disabled = wordEl.value.length < 2 || numEl.value.length !== 4;
    }

    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

    async function submit() {
      const code = wordEl.value.toUpperCase() + '-' + numEl.value;
      btn.disabled = true; btn.textContent = 'Connecting...';
      errorEl.style.display = 'none';

      try {
        const isMobile = /Mobile|iPhone|Android/i.test(navigator.userAgent);
        const res = await fetch('/api/remote-auth/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, deviceName: isMobile ? 'Mobile Browser' : 'Web Browser' })
        });

        if (!res.ok) {
          const d = await res.json().catch(() => null);
          throw new Error(d?.error || 'Invalid pairing code');
        }

        const data = await res.json();
        localStorage.setItem('opendevs_device_token', data.token);
        showDashboard(data.token, data.device?.name || null);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        btn.textContent = 'Connect';
        updateBtn();
      }
    }

    function showDashboard(token, deviceName) {
      pairView.style.display = 'none';
      dashView.classList.add('show');
      if (deviceName) {
        document.getElementById('dash-device').textContent = deviceName;
      }
      loadWorkspaces(token);
    }

    async function loadWorkspaces(token) {
      const content = document.getElementById('dash-content');
      try {
        const res = await fetch('/api/workspaces/by-repo', {
          headers: { 'Authorization': 'Bearer ' + token }
        });

        if (res.status === 401 || res.status === 403) {
          // Token revoked or invalid — go back to pairing
          localStorage.removeItem('opendevs_device_token');
          location.reload();
          return;
        }

        if (!res.ok) throw new Error('Failed to load');

        const repos = await res.json();
        if (!repos.length) {
          content.innerHTML = '<div class="empty-state">No repositories added yet.<br>Add a repo in the OpenDevs desktop app to get started.</div>';
          return;
        }

        content.innerHTML = repos.map(function(repo) {
          const wsCards = repo.workspaces.map(function(ws) {
            const name = ws.display_name || ws.directory_name;
            const branch = ws.branch || '';
            const status = ws.session_status || ws.state || 'idle';
            const statusClass = getStatusClass(status, ws.state);
            const statusLabel = getStatusLabel(status, ws.state);
            return '<div class="ws-card">' +
              '<div class="ws-info">' +
                '<span class="ws-name">' + esc(name) + '</span>' +
                (branch ? '<span class="ws-branch">' + esc(branch) + '</span>' : '') +
              '</div>' +
              '<span class="ws-status ' + statusClass + '">' + statusLabel + '</span>' +
            '</div>';
          }).join('');

          return '<div class="repo-group">' +
            '<div class="repo-name">' + esc(repo.repo_name) + '</div>' +
            '<div class="ws-list">' + (wsCards || '<div class="empty-state" style="padding:16px">No workspaces</div>') + '</div>' +
          '</div>';
        }).join('');
      } catch (err) {
        content.innerHTML = '<div class="empty-state">Could not load workspaces.</div>';
      }
    }

    function getStatusClass(sessionStatus, wsState) {
      if (wsState === 'archived') return 'archived';
      if (wsState === 'initializing') return 'initializing';
      if (wsState === 'error') return 'error';
      if (sessionStatus === 'working') return 'working';
      if (sessionStatus === 'error') return 'error';
      return 'idle';
    }

    function getStatusLabel(sessionStatus, wsState) {
      if (wsState === 'archived') return 'Archived';
      if (wsState === 'initializing') return 'Setting up';
      if (wsState === 'error') return 'Error';
      if (sessionStatus === 'working') return 'Working';
      if (sessionStatus === 'error') return 'Error';
      return 'Idle';
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }
  </script>
</body>
</html>`;
}

export default app;
