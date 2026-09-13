/* global window, document, innerWidth */
// Actual React components and HTTP client; local API/WS boundaries simulate failures.
// Run: bun test/e2e/workspace-usability.browser.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../..");
const artifacts = path.join(root, ".context/workspace-usability-ui");
await mkdir(artifacts, { recursive: true });
await writeFile(
  path.join(artifacts, "entry.tsx"),
  `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GithubCloudAccess } from "@/features/settings/ui/sections/GithubCloudAccess";
import { CloudSection } from "@/features/settings/ui/sections/CloudSection";
import { AssistantTurn } from "@/features/session/ui/AssistantTurn";
import { SessionProvider } from "@/features/session/context";
import { FileBrowserPanel } from "@/features/file-browser/ui/FileBrowserPanel";
import { useChatTabs } from "@/app/layouts/useChatTabs";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { queryKeys } from "@/shared/api/queryKeys";
import { Toaster } from "@/components/ui/sonner";
import "@/global.css";
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
window.containsCredential = value => JSON.stringify([client.getQueryCache().getAll().map(q => q.state), client.getMutationCache().getAll().map(m => m.state)]).includes(value);
const tabSessions = ["a", "b", "c", "d"].map(id => ({id, agent_harness: "claude-code", message_count: id === "b" ? 1 : 0}));
workspaceLayoutActions.setChatTabState("tab-workspace", ["a", "b", "c", "d"], "a");
client.setQueryData(queryKeys.sessions.byWorkspace("tab-workspace"), tabSessions);
function TabJourney() {
  const tabs = useChatTabs({workspaceId: "tab-workspace", activeSessionId: "a"});
  return <>
    <output>{tabs.tabs.map(tab => tab.label).join(" | ")}</output>
    <button onClick={() => client.setQueryData(queryKeys.sessions.byWorkspace("tab-workspace"), tabSessions.map(s => s.id === "a" ? {...s, message_count: 2} : s))}>Discover earlier chat</button>
    <button onClick={() => tabs.markChatTabStarted("tab-c")}>Start third chat</button>
    <button onClick={() => tabs.handleTabClose("tab-b")}>Close original chat</button>
    <button onClick={() => tabs.markChatTabStarted("tab-d")}>Start fourth chat</button>
    <button onClick={() => tabs.handleTabRestore(tabs.closedTabs[0])}>Restore original chat</button>
  </>;
}
function App() {
  const [view, setView] = useState("GitHub");
  const [phase, setPhase] = useState(0);
  const [laterTool, setLaterTool] = useState(false);
  const [fileMode, setFileMode] = useState("all");
  const messages = [{ id: "m", session_id: "s", turn_id: "turn", role: "assistant", seq: 1, parts: [
    { type: "reasoning", id: "r", text: "Check the project before changing it.", state: "done" },
    { type: "tool", id: "t", toolCallId: "t", toolName: "Bash", kind: "execute", state: { status: "completed", input: {command: "bun test"}, output: "All checks passed", title: "Run tests" } },
    { type: "text", id: "a", text: "The useful answer stays visible.", state: phase ? "done" : "streaming" },
    ...(laterTool ? [{ type: "tool", id: "t2", toolCallId: "t2", toolName: "Bash", kind: "execute", state: {status: phase ? "completed" : "in_progress", input: {command: "bun run build"}, title: "Build project", output: ""} }] : []),
  ] }];
  return <QueryClientProvider client={client}><TooltipProvider>
    <div className="bg-background text-foreground min-h-screen p-4 sm:p-8">
      <nav className="mb-6 flex gap-4">{["GitHub", "Cloud", "Chat", "Files", "Tabs"].map(name => <button key={name} onClick={() => setView(name)}>{name}</button>)}</nav>
      <main className="mx-auto max-w-3xl">
        {view === "GitHub" && <GithubCloudAccess />}
        {view === "Cloud" && <CloudSection />}
        {view === "Files" && <div className="h-[650px]"><FileBrowserPanel selectedWorkspace={{id: "workspace", kind: "cloud"} as any} filterMode={fileMode as any} onFilterModeChange={setFileMode} /></div>}
        {view === "Tabs" && <TabJourney />}
        {view === "Chat" && <>
          <button onClick={() => setPhase(p => p + 1)}>Advance turn</button>
          <button onClick={() => setLaterTool(true)}>Run another tool</button>
          <SessionProvider sessionStatus={phase === 1 ? "idle" : "working"} workspaceId="workspace" subagentMessages={new Map()}>
            <AssistantTurn messages={messages as any} isLatest={phase < 2} isWorking={phase !== 1} turn={phase ? {turnId: "turn", stopReason: "end_turn", endedAt: 1} : undefined} />
          </SessionProvider>
        </>}
      </main>
      <Toaster />
    </div>
  </TooltipProvider></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
`
);
let filesOnline = false;
let fileRequests = 0;
let failGithub = false;
const savedTokens = [];
const server = await createServer({
  configFile: false,
  root,
  cacheDir: path.join(artifacts, "vite-cache"),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  optimizeDeps: { entries: [path.join(artifacts, "entry.tsx")], force: true },
  define: {
    __APP_VERSION__: JSON.stringify("test"),
    "import.meta.env.VITE_CLOUD_DIRECT": JSON.stringify("0"),
  },
  resolve: {
    alias: { "@": path.join(root, "apps/web/src"), "@shared": path.join(root, "shared") },
  },
  plugins: [
    tailwindcss(),
    {
      name: "usability-boundaries",
      enforce: "pre",
      resolveId(id) {
        if (id.endsWith("platform/native/deus-cloud")) return "\0native";
        if (id.endsWith("/platform/ws")) return "\0ws";
        if (id.endsWith("config/api.config")) return "\0api-config";
      },
      load(id) {
        if (id === "\0api-config")
          return `export const getBaseURL = async () => location.origin + "/api"; export const getBaseURLSync = () => location.origin + "/api";`;
        if (id === "\0native")
          return `
        export * from ${JSON.stringify(path.join(root, "apps/web/src/platform/native/deus-cloud.ts"))};
        export const getSession = async () => ({signedIn: true, accountId: "fixture-user"});
        export const onAuthChanged = () => () => {};
        export const getGithubAppStatus = async () => { const r = await fetch("/api/github-status"); return r.json(); };
        export const installGithubApp = async () => ({ok: true});
      `;
        if (id === "\0ws")
          return `
        export * from ${JSON.stringify(path.join(root, "apps/web/src/platform/ws/index.ts"))};
        const listeners = new Set();
        window.reconnectFiles = () => { for (const fn of listeners) fn(true); };
        export const onConnectionChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
        export const sendRequest = async name => { const r = await fetch("/api/query/" + name); if (!r.ok) throw new Error("Cloud computer is reconnecting"); return r.json(); };
        export const sendMutate = async () => ({success: true});
      `;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url === "/") {
            res.setHeader("content-type", "text/html");
            res.end(
              '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/.context/workspace-usability-ui/entry.tsx"></script></body></html>'
            );
            return;
          }
          const json = (data, status = 200) => {
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(data));
          };
          if (req.url === "/api/settings/cloud")
            return json({ enabled: true, hasGithubToken: savedTokens.length > 0 });
          if (req.url === "/api/github-status")
            return failGithub
              ? json({
                  configured: false,
                  signedIn: true,
                  error: "offline",
                  installations: [],
                  appSlug: null,
                  accessibleRepos: null,
                })
              : json({
                  signedIn: true,
                  configured: true,
                  appSlug: "deus-bot",
                  installations: [{ accountLogin: "fixture-user" }],
                  accessibleRepos: ["deus/app"],
                });
          if (req.url === "/api/query/repos")
            return json([
              { git_origin_url: "https://github.com/deus/app.git" },
              { git_origin_url: "https://github.com/deus/other.git" },
            ]);
          if (req.url === "/api/query/workspaceFiles") {
            fileRequests++;
            return filesOnline
              ? json({
                  files: [{ name: "README.md", path: "README.md", type: "file" }],
                  totalFiles: 1,
                  totalSize: 50,
                })
              : json({}, 503);
          }
          if (req.url === "/api/settings/cloud/github-token") {
            let body = "";
            for await (const chunk of req) body += chunk;
            savedTokens.push(JSON.parse(body).token);
            return json({ ok: true });
          }
          next();
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
let page;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (err) => {
    errors.push(err.message);
    console.error(err.stack);
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByText("Installed for fixture-user").waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Manage repositories" }).getAttribute("href"),
    "https://github.com/apps/deus-bot/installations/new"
  );
  await page.getByText("deus/other", { exact: true }).waitFor();
  await page.locator("summary").click();
  const token = page.getByLabel("GitHub token", { exact: true });
  await token.pressSequentially("fixture-token-not-a-secret", { delay: 15 });
  assert.equal(await token.inputValue(), "fixture-token-not-a-secret");
  assert(
    await token.evaluate((el) => el === document.activeElement),
    "Typing must not remount the form"
  );
  await token.press("Enter");
  await page.waitForFunction(() => document.querySelector("#cloud-github-token")?.value === "");
  assert.deepEqual(savedTokens, ["fixture-token-not-a-secret"]);
  assert.equal(
    await page.evaluate(() => window.containsCredential("fixture-token-not-a-secret")),
    false
  );
  await page.screenshot({ path: path.join(artifacts, "github-desktop.png") });

  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await page.getByText("Connected to Deus Cloud", { exact: true }).waitFor();
  assert.equal(await page.locator("input[type=password]").count(), 0, "Credentials have one owner");
  await page.screenshot({ path: path.join(artifacts, "cloud-desktop.png") });

  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByText("The useful answer stays visible.", { exact: true }).waitFor();
  const disclosure = page.getByRole("button", { name: /Expand activity/ });
  await disclosure.click();
  await page.getByRole("button", { name: "Toggle thinking details" }).waitFor();
  const activityId = await page
    .getByRole("button", { name: /Collapse activity/ })
    .getAttribute("aria-controls");
  await page.evaluate((id) => {
    window.activityNode = document.getElementById(id);
  }, activityId);
  await page.getByRole("button", { name: "Run another tool" }).click();
  await page.waitForFunction(() => document.querySelector(".assistant-turn .opacity-60") === null);
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Advance turn" }).click();
    assert.equal(
      await page.getByRole("button", { name: /Collapse activity/ }).getAttribute("aria-expanded"),
      "true"
    );
    assert(
      await page.evaluate((id) => window.activityNode === document.getElementById(id), activityId),
      "Completing or starting another turn must not remount activity"
    );
  }
  await page.getByRole("button", { name: /Collapse activity/ }).click();
  await page.getByText("The useful answer stays visible.", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, "chat-desktop.png") });

  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("alert").waitFor();
  filesOnline = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("treeitem", { name: "README.md", exact: true }).waitFor();
  const before = fileRequests;
  const reconnectResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/query/workspaceFiles")
  );
  await page.evaluate(() => window.reconnectFiles());
  await reconnectResponse;
  assert.equal(fileRequests, before + 1, "A reconnect refreshes Files without a polling loop");
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.getByRole("button", { name: "All changes", exact: true }).click();
  filesOnline = false;
  await page.getByRole("menuitem", { name: "Refresh files", exact: true }).click();
  await page
    .locator('[data-sonner-toast][data-type="error"]')
    .filter({ hasText: "Cloud computer is reconnecting" })
    .waitFor();
  filesOnline = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("button", { name: "All files", exact: true }).waitFor();

  await page.getByRole("button", { name: "Tabs", exact: true }).click();
  const labels = page.locator("output");
  await page
    .getByText("New chat | Claude Code #1 | New chat | New chat", { exact: true })
    .waitFor();
  for (const [action, expected] of [
    ["Discover earlier chat", "Claude Code #2 | Claude Code #1 | New chat | New chat"],
    ["Start third chat", "Claude Code #2 | Claude Code #1 | Claude Code #3 | New chat"],
    ["Close original chat", "Claude Code #2 | Claude Code #3 | New chat"],
    ["Start fourth chat", "Claude Code #2 | Claude Code #3 | Claude Code #1"],
    ["Restore original chat", "Claude Code #2 | Claude Code #3 | Claude Code #1 | Claude Code #4"],
  ]) {
    await page.getByRole("button", { name: action, exact: true }).click();
    await page.getByText(expected, { exact: true }).waitFor();
    assert.equal(await labels.textContent(), expected);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.getByText("Installed for fixture-user").waitFor();
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "Settings must fit mobile width"
  );
  await page.screenshot({ path: path.join(artifacts, "github-mobile.png") });
  failGithub = true;
  await page.reload();
  await page.getByText("Couldn't check GitHub access.").waitFor();
  failGithub = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByText("Installed for fixture-user").waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: GitHub form focus/Enter/cache hygiene, Cloud ownership, stable chat grouping/dimming, unique tab labels, Files retry/reconnect/refresh failures, and mobile layout/error recovery"
  );
} catch (err) {
  console.error("UI state:", await page?.locator("body").innerText());
  await page?.screenshot({ path: path.join(artifacts, "failure.png") });
  throw err;
} finally {
  await browser?.close();
  await server.close();
}
