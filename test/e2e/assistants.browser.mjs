/* global window, document */
// Settings > Remote access > Assistants: the real section, the real app socket
// and runtime client, against a fake host answering the four assistant
// operations over the `q:` wire. No backend, sign-in or assistant is needed.
// Run: bun test/e2e/assistants.browser.mjs (Playwright Chromium installed).
import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

const root = path.resolve(import.meta.dirname, "../..");
const artifacts = path.join(root, ".context/assistants-ui");
await mkdir(artifacts, { recursive: true });
await writeFile(
  path.join(artifacts, "entry.tsx"),
  `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { getRuntimeClient } from "@/platform/ws";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { SettingsSidebar } from "@/features/settings/ui/SettingsSidebar";
import { AccessSection } from "@/features/settings/ui/sections/AccessSection";
import { useAssistantArrivals } from "@/features/settings/hooks/useAssistantArrivals";
import { uiActions, useUIStore } from "@/shared/stores/uiStore";
import "@/global.css";
const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
uiActions.setActiveSettingsSection("access");
if (params.get("view") === "settings") uiActions.openSettings();
const fixture = (body) => fetch("/fixture", { method: "POST", body: JSON.stringify(body) });
function App() {
  const [settings, setSettings] = useState({ remote_access_enabled: params.get("remote") !== "off" });
  window.setRemoteAccess = (on) => { setSettings((s) => ({ ...s, remote_access_enabled: on })); return fixture({ remote: on }); };
  const saveSetting = async (key, value) => {
    setSettings((s) => ({ ...s, [key]: value }));
    if (key === "remote_access_enabled") await fixture({ remote: value });
    return true;
  };
  const onSettings = useUIStore((s) => s.settingsOpen);
  useAssistantArrivals();
  return <>
    {onSettings ? <SidebarProvider><SettingsSidebar /><div className="bg-bg-surface min-w-0 flex-1">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8"><AccessSection settings={settings} saveSetting={saveSetting} /></div>
    </div></SidebarProvider> : <main className="bg-background text-foreground min-h-screen p-8">
      <p className="text-sm">A workspace, somewhere else in the app.</p>
    </main>}
    <Toaster />
  </>;
}
await getRuntimeClient().connect();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={getRuntimeClient().queryClient}><TooltipProvider><App /></TooltipProvider></QueryClientProvider>
);
`
);

// -- The fake host --------------------------------------------------------
const ADDRESS = "https://cloud.deusmachine.ai/mcp/mac-7f3a9c21";
const host = { remote: true, signedIn: true, assistants: [], writes: [], failNext: null };
const resetHost = (fields = {}) =>
  Object.assign(host, { remote: true, signedIn: true, assistants: [], writes: [] }, fields);
const subscriptions = new Map(); // id -> { socket, resource }
const answer = (resource) => {
  if (resource === "assistants") return host.assistants;
  if (resource === "pairedDevices") return { devices: [] };
  if (resource === "relayStatus")
    return {
      state: host.signedIn ? "connected" : "signed_out",
      connected: host.signedIn,
      clients: 0,
      serverId: "mac-7f3a9c21",
      serverName: "Studio Mac",
      accountId: host.signedIn ? "user-a" : null,
      relayUrl: "wss://relay.deusmachine.ai",
      error: null,
      platform: "darwin",
      assistantUrl: host.signedIn && host.remote ? ADDRESS : null,
    };
  return null;
};
const pushAssistants = () => {
  for (const [id, sub] of subscriptions)
    if (sub.resource === "assistants" && sub.socket.readyState === 1)
      sub.socket.send(JSON.stringify({ type: "q:snapshot", id, data: host.assistants }));
};
const backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(backend, "listening");
backend.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "connected", connectionId: "fixture" }));
  socket.on("close", () => {
    for (const [id, sub] of subscriptions) if (sub.socket === socket) subscriptions.delete(id);
  });
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    const send = (reply) => socket.send(JSON.stringify(reply));
    if (frame.type === "ping") return send({ type: "pong", id: frame.id });
    if (frame.type === "q:request")
      return send({ type: "q:response", id: frame.id, data: answer(frame.resource) });
    if (frame.type === "q:subscribe") {
      subscriptions.set(frame.id, { socket, resource: frame.resource });
      return send({ type: "q:snapshot", id: frame.id, data: answer(frame.resource) });
    }
    if (frame.type === "q:unsubscribe") return subscriptions.delete(frame.id);
    if (frame.type === "q:mutate") {
      host.writes.push({ action: frame.action, params: frame.params });
      if (host.failNext === frame.action) {
        host.failNext = null;
        return send({ type: "q:mutate_result", id: frame.id, success: false, error: "offline" });
      }
      const { clientId, access } = frame.params;
      if (frame.action === "setAssistantAccess")
        host.assistants = host.assistants.map((a) =>
          a.clientId === clientId ? { ...a, access } : a
        );
      if (frame.action === "removeAssistant")
        host.assistants = host.assistants.filter((a) => a.clientId !== clientId);
      send({ type: "q:mutate_result", id: frame.id, success: true, data: null });
      return pushAssistants();
    }
  });
});

const server = await createServer({
  configFile: false,
  root,
  cacheDir: path.join(artifacts, "vite-cache"),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  optimizeDeps: { entries: [path.join(artifacts, "entry.tsx")] },
  define: {
    __APP_VERSION__: JSON.stringify("test"),
    "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(String(backend.address().port)),
  },
  resolve: {
    alias: { "@": path.join(root, "apps/web/src"), "@shared": path.join(root, "shared") },
  },
  plugins: [
    tailwindcss(),
    svgr(),
    {
      name: "assistants-boundaries",
      enforce: "pre",
      resolveId(id, importer) {
        if (
          id.endsWith("/deus-cloud") &&
          (id.includes("platform/native") || importer?.includes("platform/native"))
        )
          return "\0native-deus-cloud";
      },
      load(id) {
        if (id !== "\0native-deus-cloud") return;
        // This computer's Deus sign-in: the fake host's account state.
        return `
          export * from ${JSON.stringify(path.join(root, "apps/web/src/platform/native/deus-cloud.ts"))};
          const state = () => fetch("/fixture").then((r) => r.json());
          const session = (on) => ({ signedIn: on, accountId: on ? "user-a" : null, accountEmail: on ? "ada@example.com" : null, cloudUrl: "https://cloud.test", hasPlatformKey: false, expiresAt: null, tokenType: "Bearer" });
          export const getSession = async () => session((await state()).signedIn);
          export const onAuthChanged = () => () => {};
          export async function startLogin() {
            await fetch("/fixture", { method: "POST", body: JSON.stringify({ signedIn: true }) });
            return { success: true, session: session(true) };
          }
        `;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url === "/fixture") {
            if (req.method === "POST") {
              let body = "";
              for await (const chunk of req) body += chunk;
              Object.assign(host, JSON.parse(body));
            }
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify(host));
          }
          if (req.url !== "/" && !req.url.startsWith("/?")) return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/.context/assistants-ui/entry.tsx"></script></body></html>'
          );
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0 },
});

const now = Date.now();
const chatgpt = {
  clientId: "chatgpt",
  name: "ChatGPT",
  host: "chatgpt.com",
  access: "pending",
  createdAt: now,
  lastSeenAt: now,
};
const claude = {
  clientId: "claude",
  name: "Claude",
  host: "claude.ai",
  access: "operate",
  createdAt: now - 86_400_000,
  lastSeenAt: now - 3 * 3_600_000,
};
// No host known yet: shown by its client id, shortened in the middle.
const grok = {
  clientId: "dcr_8c41f0b2e97a4d1c9b35",
  name: "Grok Bot",
  host: null,
  access: "pending",
  createdAt: now,
  lastSeenAt: now,
};
const GROK_ID = "dcr_8c41f0…a4d1c9b35";
const impostor = {
  clientId: "impostor",
  name: "ChatGPT Pro",
  host: "chatgpt-pro.example",
  access: "denied",
  createdAt: now - 2 * 86_400_000,
  lastSeenAt: now - 2 * 86_400_000,
};

let browser;
const errors = [];
const shots = [];
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const visit = async (
    query,
    { theme = "light", viewport = { width: 1180, height: 820 } } = {}
  ) => {
    const context = await browser.newContext({ viewport, colorScheme: theme });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(`${base}/?theme=${theme}&${query}`);
    return page;
  };
  const shot = async (page, name) => {
    // Let entrances and toasts settle before the picture.
    await page.waitForTimeout(400);
    const file = path.join(artifacts, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    shots.push(file);
  };
  const section = (page) => page.getByRole("heading", { name: "Assistants", exact: true });
  const dialog = (page) => page.getByRole("dialog");
  const openAdd = async (page) => {
    await page.getByRole("button", { name: "Add assistant" }).click();
    await dialog(page).getByRole("heading", { name: "Add an assistant" }).waitFor();
  };
  const closeDialog = async (page) => {
    await page.keyboard.press("Escape");
    await dialog(page).waitFor({ state: "detached" });
  };

  // -- Empty state, and Add assistant with the address -----------------------
  resetHost();
  let page = await visit("view=settings");
  await section(page).waitFor();
  await page.getByText("No assistants yet.", { exact: true }).waitFor();
  await page
    .getByText(
      "Let an assistant like ChatGPT or Claude see your workspaces and work with your agents on this computer."
    )
    .waitFor();
  await shot(page, "01-empty-light");

  await openAdd(page);
  const field = dialog(page).getByRole("textbox", { name: "This computer's address" });
  assert.equal(await field.inputValue(), ADDRESS);
  for (const step of [
    "In your assistant, add a custom connector (MCP) and paste this address.",
    "Sign in with your Deus account when it asks.",
    "Come back here and allow it.",
  ])
    await dialog(page).getByText(step, { exact: true }).waitFor();
  await dialog(page).getByRole("button", { name: "Copy address" }).click();
  await page.getByText("Address copied", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), ADDRESS);
  await shot(page, "02-add-address-light");
  await closeDialog(page);

  // -- Unavailable: signed out, fixed in place by signing in ------------------
  await page.evaluate(() =>
    fetch("/fixture", { method: "POST", body: JSON.stringify({ signedIn: false }) })
  );
  await page.reload();
  await page.getByText("Sign in to use remote access", { exact: true }).waitFor();
  await openAdd(page);
  await dialog(page).getByText("Sign in to add an assistant", { exact: true }).waitFor();
  await dialog(page)
    .getByText("Assistants reach this computer through your Deus account.", { exact: true })
    .waitFor();
  await shot(page, "03-add-signed-out-light");
  await dialog(page).getByRole("button", { name: "Sign in" }).click();
  await dialog(page).getByRole("textbox", { name: "This computer's address" }).waitFor();
  await closeDialog(page);

  // -- Unavailable: remote access off, fixed in place by the switch -----------
  await page.evaluate(() => window.setRemoteAccess(false));
  await page.getByText("Devices that can control this computer").waitFor({ state: "detached" });
  await section(page).waitFor();
  await openAdd(page);
  await dialog(page).getByText("Turn on remote access", { exact: true }).waitFor();
  await shot(page, "04-add-remote-off-light");
  await dialog(page).getByRole("switch", { name: "Allow remote access" }).click();
  await dialog(page).getByRole("textbox", { name: "This computer's address" }).waitFor();
  assert.equal(host.remote, true);
  await closeDialog(page);
  await page.close();

  // -- A waiting assistant arrives while the person is elsewhere --------------
  resetHost();
  page = await visit("view=app");
  await page.getByText("A workspace, somewhere else in the app.").waitFor();
  await page.waitForTimeout(500);
  host.assistants = [chatgpt];
  pushAssistants();
  const toastOf = (name) =>
    page.locator("[data-sonner-toast]").filter({ hasText: `${name} wants to connect` });
  await toastOf("ChatGPT").waitFor();
  // Where it signs in, as the row says it, since anyone can call itself ChatGPT.
  await toastOf("ChatGPT")
    .getByText(
      "Signs in through chatgpt.com. Allow it to see your workspaces and work with your agents.",
      { exact: true }
    )
    .waitFor();
  // The same assistant, seen again: still one toast.
  host.assistants = [{ ...chatgpt, lastSeenAt: now + 1 }];
  pushAssistants();
  await page.waitForTimeout(400);
  assert.equal(await toastOf("ChatGPT").count(), 1);
  // A denied assistant never asks: no toast.
  host.assistants = [{ ...chatgpt, lastSeenAt: now + 1 }, impostor];
  pushAssistants();
  await page.waitForTimeout(400);
  assert.equal(await toastOf("ChatGPT Pro").count(), 0);
  await shot(page, "05-toast-light");

  // Removed elsewhere, then asking again later: a new request, so a new toast.
  host.assistants = [];
  pushAssistants();
  await toastOf("ChatGPT").waitFor({ state: "detached" });
  host.assistants = [{ ...chatgpt, createdAt: now + 2, lastSeenAt: now + 2 }];
  pushAssistants();
  await toastOf("ChatGPT").waitFor();

  // Review opens Settings > Remote access, where the request is first and stands out.
  await toastOf("ChatGPT").getByRole("button", { name: "Review" }).click();
  await section(page).waitFor();
  await toastOf("ChatGPT").waitFor({ state: "detached" });
  await page.getByRole("img", { name: "1 assistant waiting" }).waitFor();
  await page.getByText("ChatGPT wants to connect", { exact: true }).waitFor();
  // Where it signs in, since anyone can call itself ChatGPT.
  await page.getByText("Signs in through chatgpt.com · Asked just now", { exact: true }).waitFor();
  await shot(page, "06-waiting-light");

  // Allow, as Read only; the menu says to allow only what you just connected.
  await page.getByRole("button", { name: "Allow ChatGPT" }).click();
  const items = page.getByRole("menuitem");
  assert.deepEqual(
    (await items.allInnerTexts()).map((t) => t.split("\n")[0]),
    ["Read only", "Operate"]
  );
  await page
    .getByRole("menu")
    .getByText("Only allow an assistant you just connected yourself.", { exact: true })
    .waitFor();
  await items.filter({ hasText: "Read only" }).click();
  await page.getByRole("button", { name: "Access for ChatGPT: Read only" }).waitFor();
  assert.deepEqual(host.writes.at(-1), {
    action: "setAssistantAccess",
    params: { clientId: "chatgpt", access: "read" },
  });
  await page.getByText("Allowed ChatGPT to read", { exact: true }).waitFor();
  await page.getByRole("img", { name: /waiting/ }).waitFor({ state: "detached" });

  // A failed change keeps the access as it was and says so.
  host.failNext = "setAssistantAccess";
  await page.getByRole("button", { name: "Access for ChatGPT: Read only" }).click();
  await page.getByRole("menuitemradio", { name: /Operate/ }).click();
  await page.getByText("Couldn't change access. Try again.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Access for ChatGPT: Read only" }).waitFor();

  // Change to Operate.
  await page.getByRole("button", { name: "Access for ChatGPT: Read only" }).click();
  await page.getByRole("menuitemradio", { name: /Operate/ }).click();
  await page.getByRole("button", { name: "Access for ChatGPT: Operate" }).waitFor();
  assert.deepEqual(host.writes.at(-1).params, { clientId: "chatgpt", access: "operate" });
  await page.getByText("chatgpt.com · Last used just now", { exact: true }).waitFor();
  await shot(page, "07-allowed-light");

  // A request arriving while the page is open, from an assistant whose host is
  // not known yet: the row, unverified, named by its client id; no toast.
  host.assistants = [...host.assistants, grok];
  pushAssistants();
  await page.getByText("Grok Bot wants to connect", { exact: true }).waitFor();
  await page.getByText(`Unverified ${GROK_ID} · Asked just now`, { exact: true }).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await toastOf("Grok Bot").count(), 0);
  await shot(page, "15-unverified-light");

  // Deny keeps it, listed last and quietly as denied.
  await page.getByRole("button", { name: "Deny" }).click();
  await page.getByText("Grok Bot wants to connect", { exact: true }).waitFor({ state: "detached" });
  assert.deepEqual(host.writes.at(-1), {
    action: "setAssistantAccess",
    params: { clientId: grok.clientId, access: "denied" },
  });
  await page.getByText("Denied Grok Bot", { exact: true }).waitFor();
  const grokActions = page.getByRole("button", { name: "Actions for Grok Bot" });
  await grokActions.waitFor();
  await page.getByText("Denied", { exact: true }).waitFor();
  const order = await page.locator("p.truncate.text-sm.font-medium").allInnerTexts();
  assert.deepEqual(order, ["ChatGPT", "Grok Bot"]);
  await shot(page, "14-denied-light");

  // Allow it from the menu after all.
  await grokActions.click();
  assert.deepEqual(await page.getByRole("menuitem").allInnerTexts(), [
    "Read only",
    "Operate",
    "Remove",
  ]);
  await page.getByRole("menuitem", { name: "Read only" }).click();
  await page.getByRole("button", { name: "Access for Grok Bot: Read only" }).waitFor();
  assert.deepEqual(host.writes.at(-1).params, { clientId: grok.clientId, access: "read" });

  // Denied again, then removed from its menu (with the confirmation): gone.
  host.assistants = host.assistants.map((a) =>
    a.clientId === grok.clientId ? { ...a, access: "denied" } : a
  );
  pushAssistants();
  await grokActions.click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await dialog(page)
    .getByText(/Grok Bot can no longer reach this computer/)
    .waitFor();
  await dialog(page).getByRole("button", { name: "Remove" }).click();
  await grokActions.waitFor({ state: "detached" });
  assert.deepEqual(host.writes.at(-1), {
    action: "removeAssistant",
    params: { clientId: grok.clientId },
  });
  await dialog(page).waitFor({ state: "detached" });

  // Remove, with the same confirmation devices use.
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog(page).getByRole("heading", { name: "Remove assistant?" }).waitFor();
  await dialog(page)
    .getByText(/ChatGPT can no longer reach this computer/)
    .waitFor();
  await shot(page, "08-remove-confirm-light");
  await dialog(page).getByRole("button", { name: "Remove" }).click();
  await page.getByText("No assistants yet.", { exact: true }).waitFor();
  assert.deepEqual(host.writes.at(-1), {
    action: "removeAssistant",
    params: { clientId: "chatgpt" },
  });
  await page.close();

  // -- Already waiting when the app opened: no toast, only the sidebar mark ---
  resetHost({ assistants: [chatgpt] });
  page = await visit("view=app");
  await page.getByText("A workspace, somewhere else in the app.").waitFor();
  await page.waitForTimeout(1200);
  assert.equal(await toastOf("ChatGPT").count(), 0);
  await page.close();

  // -- Dark, desktop ---------------------------------------------------------
  resetHost({ assistants: [impostor, claude, chatgpt] });
  page = await visit("view=settings", { theme: "dark" });
  await page.getByText("ChatGPT wants to connect", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Access for Claude: Operate" }).waitFor();
  await page.getByText("claude.ai · Last used 3h ago", { exact: true }).waitFor();
  await shot(page, "09-list-dark");
  await page.getByRole("button", { name: "Access for Claude: Operate" }).click();
  await page.getByRole("menuitemradio", { name: /Read only/ }).waitFor();
  await shot(page, "10-access-menu-dark");
  await page.keyboard.press("Escape");
  await openAdd(page);
  await shot(page, "11-add-address-dark");
  await page.close();

  // -- Phone width, light and dark: nothing leaves the screen -----------------
  for (const theme of ["light", "dark"]) {
    resetHost({ assistants: [impostor, claude, chatgpt] });
    page = await visit("view=settings", { theme, viewport: { width: 390, height: 844 } });
    await page.getByText("ChatGPT wants to connect", { exact: true }).waitFor();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    assert(overflow <= 0, `the page scrolls sideways by ${overflow}px at 390px`);
    for (const name of [
      "Allow ChatGPT",
      "Deny",
      "Access for Claude: Operate",
      "Remove",
      "Actions for ChatGPT Pro",
    ]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= 390, `${name} leaves the screen`);
    }
    await shot(page, `12-mobile-${theme}`);
    await openAdd(page);
    const box = await dialog(page).boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 390, "the dialog leaves the screen");
    await shot(page, `13-mobile-add-${theme}`);
    await page.close();
  }

  assert.deepEqual(errors, []);
  console.log(
    "PASS: assistants: empty state, Add with the address and copy, signed out and remote access off fixed in place, a request arriving live (one toast per request, none for denied, a new one after removal, Review), where each signs in (known host, unverified id), Allow as Read only, a failed change, Operate, Deny kept as denied, Allow from its menu, Remove from its menu, Remove, no toast for requests already waiting, dark, phone width"
  );
  console.log(shots.map((file) => path.relative(root, file)).join("\n"));
} finally {
  await browser?.close();
  await server.close();
  for (const socket of backend.clients) socket.terminate();
  await new Promise((resolve) => backend.close(resolve));
}
