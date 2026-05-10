// packages/pencil/src/ui/app.ts
//
// Iframe wrapper. The iframe loads the actual Pencil editor in webappapi
// mode; this file does three things:
//   1. Bridges the editor's postMessage IPC to our backend (POST /ipc).
//   2. Subscribes to /events SSE for op progress + ipc-notify push events
//      from the host (forwarded to the iframe via postMessage).
//   3. Manages auth (sign-in card overlay) + topbar status.

// ---- types --------------------------------------------------------------

interface IpcMessage {
  id: string;
  type: "request" | "response" | "notification";
  method: string;
  payload?: unknown;
  error?: { code: string; message: string; stack?: string };
}

interface AuthStatus {
  authed: boolean;
  cliKeySet: boolean;
  cliKeySource: "env" | "file" | null;
  sessionFile: string;
  sessionExists: boolean;
  sessionValid: boolean;
  sessionEmail: string | null;
  deusCliKeyFile: string;
}
interface AuthSetResponse extends AuthStatus {
  ok: boolean;
  email?: string;
  error?: string;
}

type OpKind = "design" | "iterate" | "export";
interface Design {
  name: string;
  file: string;
  inWorkspace: boolean;
  modifiedAt: string;
  sizeBytes: number;
}
interface DesignsResponse {
  designs: Design[];
  active: string | null;
  currentOp: { id: string; kind: OpKind; name: string; startedAt: number } | null;
}

interface OpStartEvent {
  id: string;
  kind: OpKind;
  name: string;
  startedAt: number;
}
interface OpEndEvent {
  id: string;
  kind: OpKind;
  name: string;
  ok: boolean;
  code: number;
  durationMs: number;
}

type StatusState = "" | "live" | "warn" | "run";

// ---- DOM ---------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing DOM element #${id}`);
  return el as T;
};
const dom = {
  dot: $("dot"),
  status: $("status"),
  auth: $("auth"),
  version: $("version"),
  switcher: $("switcher"),
  switcherTrigger: $<HTMLButtonElement>("switcher-trigger"),
  switcherLabel: $("switcher-label"),
  switcherDot: $("switcher-dot"),
  switcherMenu: $("switcher-menu"),
  iframe: $<HTMLIFrameElement>("editor"),
  running: $("running"),
  runLabel: $("run-label"),
  runElapsed: $("run-elapsed"),
  cancelBtn: $<HTMLButtonElement>("cancel"),
  signinOverlay: $("signin-overlay"),
  signinForm: $<HTMLFormElement>("signin-form"),
  signinKey: $<HTMLInputElement>("signin-key"),
  signinButton: $<HTMLButtonElement>("signin-button"),
  signinError: $("signin-error"),
  toast: $("toast"),
};

// ---- state -------------------------------------------------------------

const state = {
  signedIn: false,
  verifiedEmail: null as string | null,
  runStartedAt: null as number | null,
  elapsedTimer: null as number | null,
  toastTimer: null as number | null,
};

// ---- toast / status -----------------------------------------------------

function toast(text: string, kind: "info" | "error" = "info"): void {
  dom.toast.textContent = text;
  dom.toast.classList.remove("toast--error");
  dom.toast.classList.add("toast--show");
  if (kind === "error") dom.toast.classList.add("toast--error");
  if (state.toastTimer !== null) clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => dom.toast.classList.remove("toast--show"), 2400);
}

function setStatus(s: StatusState, text: string): void {
  dom.dot.dataset.state = s;
  dom.status.textContent = text;
}

// ---- net helpers --------------------------------------------------------

async function jsonFetch<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  try {
    return text.length ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    return { error: `bad response (${res.status})` } as unknown as T;
  }
}

async function postJson<T = unknown>(url: string, payload: unknown): Promise<T> {
  return jsonFetch<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}

// ---- IPC bridge ---------------------------------------------------------
//
// The editor in webappapi mode posts IPC messages to its parent (us).
// We forward them to /ipc; the backend's handler returns a response,
// which we relay back to the iframe via iframe.contentWindow.postMessage.
// Notifications (no expected response) just round-trip and we drop the
// 202 ACK on the floor.

async function handleEditorMessage(msg: IpcMessage): Promise<void> {
  // Forward to backend.
  let reply: IpcMessage | null = null;
  try {
    const res = await fetch("/ipc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    if (res.status === 202) return; // notification, no reply
    if (res.ok) reply = (await res.json()) as IpcMessage;
    else {
      console.warn("[ipc] /ipc HTTP", res.status, await res.text());
      // Synthesize an error response so the editor's pending request resolves.
      if (msg.type === "request") {
        reply = {
          id: msg.id,
          type: "response",
          method: msg.method,
          error: { code: "TRANSPORT_ERROR", message: `HTTP ${res.status}` },
        };
      }
    }
  } catch (err) {
    if (msg.type === "request") {
      reply = {
        id: msg.id,
        type: "response",
        method: msg.method,
        error: {
          code: "TRANSPORT_ERROR",
          message: (err as Error).message,
        },
      };
    }
  }
  if (reply && dom.iframe.contentWindow) {
    dom.iframe.contentWindow.postMessage(reply, "*");
  }
}

// Track responses to host-initiated requests (id starts with "host-")
// so we can POST them to /ipc-response instead of /ipc.
async function relayEditorReply(msg: IpcMessage): Promise<void> {
  try {
    await fetch("/ipc-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
  } catch (err) {
    console.warn("[ipc] failed to relay editor reply:", err);
  }
}

window.addEventListener("message", (ev) => {
  if (ev.source !== dom.iframe.contentWindow) return;
  const data = ev.data;
  if (!data || typeof data !== "object") return;
  const msg = data as Partial<IpcMessage>;
  if (!msg.id || !msg.type || !msg.method) return;
  // If this is a response to a host-initiated request, relay to the
  // backend's RPC channel. Otherwise it's an editor → host message
  // and goes through /ipc.
  if (msg.type === "response" && typeof msg.id === "string" && msg.id.startsWith("host-")) {
    void relayEditorReply(msg as IpcMessage);
    return;
  }
  void handleEditorMessage(msg as IpcMessage);
});

function pushToEditor(msg: IpcMessage): void {
  if (dom.iframe.contentWindow) dom.iframe.contentWindow.postMessage(msg, "*");
}

// ---- SSE event stream ---------------------------------------------------

function connectEvents(): void {
  const es = new EventSource("/events");
  es.addEventListener("op-start", (ev) => {
    const op = JSON.parse((ev as MessageEvent).data) as OpStartEvent;
    showRunningPill(op);
  });
  es.addEventListener("op-end", (ev) => {
    const op = JSON.parse((ev as MessageEvent).data) as OpEndEvent;
    hideRunningPill(op);
  });
  es.addEventListener("op-phase", (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as { phase: string };
    if (state.runStartedAt !== null) {
      dom.runLabel.textContent = data.phase.toLowerCase();
    }
  });
  es.addEventListener("ipc-notify", (ev) => {
    // Backend pushes IPC notifications meant for the editor; relay them.
    const msg = JSON.parse((ev as MessageEvent).data) as IpcMessage;
    console.log("[pencil-iframe] ← ipc-notify", msg.method);
    pushToEditor(msg);
  });
  es.addEventListener("ipc-request", (ev) => {
    // Backend wants the editor to handle a request — forward to the
    // iframe; the editor's response will come back through the window
    // message listener and get relayed via /ipc-response.
    const msg = JSON.parse((ev as MessageEvent).data) as IpcMessage;
    console.log("[pencil-iframe] ← ipc-request", msg.method);
    pushToEditor(msg);
  });
  es.addEventListener("active-file", () => {
    // The tabs UI now reflects the active file; refresh the design list
    // to pick up the change.
    void refreshDesigns();
  });
  es.onerror = () => {
    if (state.runStartedAt === null && state.signedIn) {
      setStatus("warn", "events disconnected");
    }
  };
}

function showRunningPill(op: OpStartEvent): void {
  state.runStartedAt = op.startedAt || Date.now();
  dom.running.hidden = false;
  dom.runLabel.textContent = `${op.kind} · ${op.name}`;
  setStatus("run", `${op.kind} · ${op.name}`);
  if (state.elapsedTimer !== null) clearInterval(state.elapsedTimer);
  state.elapsedTimer = window.setInterval(() => {
    const s = Math.floor((Date.now() - (state.runStartedAt ?? Date.now())) / 1000);
    dom.runElapsed.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 250);
}

function hideRunningPill(op: OpEndEvent): void {
  dom.running.hidden = true;
  state.runStartedAt = null;
  if (state.elapsedTimer !== null) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }
  setStatus("live", op.ok ? "ready" : `${op.kind} failed`);
}

// ---- toolbar actions ----------------------------------------------------

dom.cancelBtn.addEventListener("click", async () => {
  dom.cancelBtn.disabled = true;
  dom.cancelBtn.textContent = "Cancelling…";
  try {
    await postJson("/cancel", {});
  } finally {
    setTimeout(() => {
      dom.cancelBtn.disabled = false;
      dom.cancelBtn.textContent = "Cancel";
    }, 1500);
  }
});

// ---- auth flow ----------------------------------------------------------

async function checkAuth(): Promise<void> {
  try {
    const data = await jsonFetch<AuthStatus>("/auth-status");
    if (!data.authed) {
      state.signedIn = false;
      dom.auth.textContent = "not signed in";
      dom.auth.style.color = "var(--warn)";
      dom.signinOverlay.hidden = false;
    } else {
      state.signedIn = true;
      dom.signinOverlay.hidden = true;
      const email = data.sessionEmail || state.verifiedEmail;
      dom.auth.textContent = email
        ? `signed in · ${email}`
        : data.cliKeySource === "env"
          ? "signed in · cli key (env)"
          : "signed in · cli key";
      dom.auth.style.color = "var(--fg-muted)";
      setStatus("live", "ready");
    }
  } catch {
    /* keep last state */
  }
}

dom.signinForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const key = dom.signinKey.value.trim();
  if (!key) return;
  dom.signinButton.disabled = true;
  dom.signinButton.textContent = "Verifying…";
  dom.signinError.textContent = "";
  try {
    const result = await postJson<AuthSetResponse>("/auth-set", { key });
    if (!result.ok) {
      dom.signinError.textContent = result.error || "save failed";
      return;
    }
    if (result.email) state.verifiedEmail = result.email;
    toast(result.email ? `Signed in as ${result.email}` : "Signed in");
    await checkAuth();
    // Reload the iframe so the editor picks up the freshly-stored session.
    dom.iframe.src = "/editor/?reauth=" + Date.now();
  } catch (err) {
    dom.signinError.textContent = (err as Error).message;
  } finally {
    dom.signinButton.disabled = false;
    dom.signinButton.textContent = "Verify";
  }
});

// ---- design switcher (multi-file workspace picker) -------------------
//
// Linear-style: trigger shows the active filename, click opens a
// dropdown listing every .pen in the workspace, grouped by location.

let designs: Design[] = [];
let activeFile: string | null = null;
let menuOpen = false;

async function refreshDesigns(): Promise<void> {
  try {
    const data = await jsonFetch<DesignsResponse>("/designs");
    designs = data.designs ?? [];
    activeFile = data.active;
    renderTrigger();
    if (menuOpen) renderMenu();
  } catch {
    /* offline — keep last list */
  }
}

function activeDesign(): Design | null {
  return designs.find((d) => d.file === activeFile) ?? null;
}

function renderTrigger(): void {
  const active = activeDesign();
  if (active) {
    dom.switcherTrigger.classList.remove("is-empty");
    dom.switcherDot.classList.toggle("is-workspace", active.inWorkspace);
    dom.switcherLabel.className = "switcher-name";
    dom.switcherLabel.textContent = active.name;
    dom.switcherTrigger.title =
      active.file + (active.inWorkspace ? "  (workspace)" : "  (storage)");
  } else if (designs.length > 0) {
    dom.switcherTrigger.classList.remove("is-empty");
    dom.switcherDot.classList.remove("is-workspace");
    dom.switcherLabel.className = "switcher-name-empty";
    dom.switcherLabel.textContent = `${designs.length} design${designs.length === 1 ? "" : "s"}`;
    dom.switcherTrigger.title = "Choose a design";
  } else {
    dom.switcherTrigger.classList.add("is-empty");
    dom.switcherDot.classList.remove("is-workspace");
    dom.switcherLabel.className = "switcher-name-empty";
    dom.switcherLabel.textContent = "no design";
    dom.switcherTrigger.title = "No .pen files in this workspace yet";
  }
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  const month = Math.floor(day / 30);
  return month < 12 ? `${month}mo` : `${Math.floor(month / 12)}y`;
}

function renderMenu(): void {
  dom.switcherMenu.innerHTML = "";

  if (designs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "switcher-empty";
    empty.textContent = "No .pen files yet.";
    dom.switcherMenu.appendChild(empty);
  } else {
    const workspaceDesigns = designs.filter((d) => d.inWorkspace);
    const storageDesigns = designs.filter((d) => !d.inWorkspace);
    if (workspaceDesigns.length > 0) {
      appendSection("In workspace");
      workspaceDesigns.forEach(appendItem);
    }
    if (storageDesigns.length > 0) {
      appendSection("Generated");
      storageDesigns.forEach(appendItem);
    }
  }

  appendDivider();
  appendNewButton();
}

function appendDivider(): void {
  const d = document.createElement("div");
  d.className = "switcher-divider";
  dom.switcherMenu.appendChild(d);
}

function appendNewButton(): void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "switcher-new";
  btn.innerHTML = `
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </svg>
    <span>New design</span>
  `;
  btn.addEventListener("click", openNewDesignForm);
  dom.switcherMenu.appendChild(btn);
}

function openNewDesignForm(): void {
  dom.switcherMenu.innerHTML = "";

  const form = document.createElement("form");
  form.className = "switcher-form";
  form.setAttribute("aria-label", "New design");

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "name (e.g. agent-layout)";
  nameInput.autocomplete = "off";
  nameInput.spellcheck = false;
  nameInput.required = true;

  const hint = document.createElement("div");
  hint.style.cssText = "font-size:10.5px;color:var(--fg-muted);line-height:1.45;";
  hint.textContent =
    "Opens a blank canvas. Then ask the agent to design it — every op renders live.";

  const row = document.createElement("div");
  row.className = "switcher-form-row";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn--ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", (ev) => {
    ev.preventDefault();
    closeMenu();
  });

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn btn--primary";
  submit.textContent = "Create";

  row.append(cancel, submit);
  form.append(nameInput, hint, row);
  dom.switcherMenu.appendChild(form);

  setTimeout(() => nameInput.focus(), 0);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    submit.disabled = true;
    submit.textContent = "Opening…";
    try {
      const ok = await callNewDesignTool(name);
      if (ok) {
        closeMenu();
        toast(`Blank canvas: ${name}`);
        void refreshDesigns();
      } else {
        submit.disabled = false;
        submit.textContent = "Create";
      }
    } catch (err) {
      toast((err as Error).message ?? "failed to start", "error");
      submit.disabled = false;
      submit.textContent = "Create";
    }
  });
}

interface McpResp {
  result?: { isError?: boolean; content?: { type: string; text: string }[] };
  error?: { message?: string };
}

async function callNewDesignTool(name: string): Promise<boolean> {
  const res = await fetch("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: "pencil_new", arguments: { name } },
    }),
  });
  if (!res.ok) {
    toast(`new failed (HTTP ${res.status})`, "error");
    return false;
  }
  const body = (await res.json()) as McpResp;
  if (body.error) {
    toast(body.error.message ?? "new failed", "error");
    return false;
  }
  if (body.result?.isError) {
    const text = body.result.content?.[0]?.text ?? "new failed";
    toast(text, "error");
    return false;
  }
  return true;
}

function appendSection(label: string): void {
  const h = document.createElement("div");
  h.className = "switcher-section";
  h.textContent = label;
  dom.switcherMenu.appendChild(h);
}

function appendItem(d: Design): void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "switcher-item" + (d.file === activeFile ? " is-active" : "");
  btn.setAttribute("role", "option");
  btn.setAttribute("aria-selected", String(d.file === activeFile));
  btn.title = d.file;
  btn.innerHTML = `
    <span class="switcher-item-name"></span>
    <span class="switcher-item-meta"></span>
  `;
  (btn.querySelector(".switcher-item-name") as HTMLElement).textContent = d.name;
  (btn.querySelector(".switcher-item-meta") as HTMLElement).textContent = relativeAge(d.modifiedAt);
  btn.addEventListener("click", () => {
    closeMenu();
    void switchTo(d.file);
  });
  dom.switcherMenu.appendChild(btn);
}

function openMenu(): void {
  if (menuOpen) return;
  menuOpen = true;
  renderMenu();
  dom.switcherMenu.hidden = false;
  dom.switcherTrigger.setAttribute("aria-expanded", "true");
}

function closeMenu(): void {
  if (!menuOpen) return;
  menuOpen = false;
  dom.switcherMenu.hidden = true;
  dom.switcherTrigger.setAttribute("aria-expanded", "false");
}

dom.switcherTrigger.addEventListener("click", (ev) => {
  ev.stopPropagation();
  if (menuOpen) closeMenu();
  else openMenu();
});

document.addEventListener("click", (ev) => {
  if (!menuOpen) return;
  if (!(ev.target instanceof Node)) return;
  if (!dom.switcher.contains(ev.target)) closeMenu();
});

document.addEventListener("keydown", (ev) => {
  if (menuOpen && ev.key === "Escape") {
    closeMenu();
    dom.switcherTrigger.focus();
  }
});

async function switchTo(file: string): Promise<void> {
  try {
    const result = await postJson<{ ok: boolean; error?: string; file?: string }>("/active", {
      file,
    });
    if (!result.ok) {
      toast(result.error || "couldn't switch design", "error");
      return;
    }
    activeFile = result.file ?? file;
    renderTrigger();
  } catch (err) {
    toast(String(err instanceof Error ? err.message : err), "error");
  }
}

// ---- CLI version chip ---------------------------------------------------

async function fetchCliInfo(): Promise<void> {
  try {
    const body = await jsonFetch<{ version?: string }>("/cli-info");
    if (body && body.version) {
      dom.version.textContent = `v${body.version}`;
      dom.version.hidden = false;
    }
  } catch {
    /* ignore */
  }
}

// ---- boot --------------------------------------------------------------

dom.iframe.addEventListener("load", () => setStatus("live", "ready"));

void checkAuth();
void refreshDesigns();
connectEvents();
void fetchCliInfo();
window.setInterval(checkAuth, 15_000);
window.setInterval(refreshDesigns, 8_000);
