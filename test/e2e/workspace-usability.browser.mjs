/* global window, document, innerWidth */
// Actual React components and HTTP client; local API/WS boundaries simulate failures.
// Run: bun test/e2e/workspace-usability.browser.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";
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
import { OnboardingOverlay } from "@/features/onboarding/ui/OnboardingOverlay";
import { AssistantTurn } from "@/features/session/ui/AssistantTurn";
import { SessionComposer } from "@/features/session/ui/SessionComposer";
import { makeCloudFrameHandler } from "@/features/session/cloud/cloudFrameHandler";
import { createStreamCursor } from "@/features/session/lib/agentEventFold";
import { SessionProvider } from "@/features/session/context";
import { FileBrowserPanel } from "@/features/file-browser/ui/FileBrowserPanel";
import { useChatTabs } from "@/app/layouts/useChatTabs";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { queryKeys } from "@/shared/api/queryKeys";
import { Toaster } from "@/components/ui/sonner";
import "@/global.css";
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
window.containsCredential = value => JSON.stringify([client.getQueryCache().getAll().map(q => q.state), client.getMutationCache().getAll().map(m => m.state)]).includes(value);
window.deliverEmptyCloudSnapshot = () => makeCloudFrameHandler({
  queryClient: client, activeSessionId: "history-session", folds: new Map(),
  cursor: createStreamCursor(), scheduleFlush: () => {}, requestRefetch: () => {},
}, "history-session")({
  type: "session.snapshot", messages: [], events: [],
  state: {sessionId: "provider-session", status: "ready", currentTurnId: null, turns: []},
});
const tabSessions = ["a", "b", "c", "d"].map(id => ({id, agent_harness: "claude-code", message_count: id === "b" ? 1 : 0}));
workspaceLayoutActions.setChatTabState("tab-workspace", ["a", "b", "c", "d"], "a");
client.setQueryData(queryKeys.sessions.byWorkspace("tab-workspace"), tabSessions);
function TabJourney() {
  const tabs = useChatTabs({workspaceId: "tab-workspace", activeSessionId: "a"});
  return <>
    <output data-model={tabs.activeTab?.initialModel ?? ""} data-harness={tabs.activeTab?.agentHarness}>{tabs.tabs.map(tab => tab.label).join(" | ")}</output>
    <button onClick={() => client.setQueryData(queryKeys.sessions.byWorkspace("tab-workspace"), tabSessions.map(s => s.id === "a" ? {...s, message_count: 2} : s))}>Discover earlier chat</button>
    <button onClick={() => tabs.markChatTabStarted("tab-c")}>Start third chat</button>
    <button onClick={() => tabs.handleTabClose("tab-b")}>Close original chat</button>
    <button onClick={() => tabs.markChatTabStarted("tab-d")}>Start fourth chat</button>
    <button onClick={() => tabs.handleTabRestore(tabs.closedTabs[0])}>Restore original chat</button>
    <button onClick={() => tabs.handleTabAdd("codex-app-server:gpt-6-astra")}>Open Codex chat</button>
    <button onClick={() => tabs.updateChatTabAgentHarness(tabs.activeTab.id, "claude-code")}>Choose Claude</button>
    <button onClick={() => tabs.markChatTabStarted(tabs.activeTab.id)}>Start active chat</button>
    <button onClick={() => client.setQueryData(queryKeys.sessions.byWorkspace("tab-workspace"), sessions => sessions.map(s => s.id === tabs.activeTab.sessionId ? {...s, message_count: 1, agent_harness: "claude-code"} : s))}>Discover active chat</button>
    <button onClick={() => tabs.handleTabClose(tabs.activeTab.id)}>Close active chat</button>
  </>;
}
function App() {
  const [view, setView] = useState(location.search === "?history" ? "History" : location.search ? "Onboarding" : "GitHub");
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
        {view === "Onboarding" && <OnboardingOverlay />}
        {view === "History" && <SessionComposer sessionId="history-session" />}
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
let failRecentProjects = true;
let failFinishSetup = true;
let failHistory = true;
let historyRequests = 0;
let directHistory = false;
let failAgentAuth = true;
const createdSessions = [];
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
    svgr(),
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
          return `export const getBaseURL = async () => location.origin + "/api"; export const getBaseURLSync = () => location.origin + "/api"; export const getBackendUrl = async () => location.origin;`;
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
        export const sendMutate = async (name, params) => { const r = await fetch("/api/mutate/" + name, {method: "POST", body: JSON.stringify(params)}); return r.json(); };
      `;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] === "/") {
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
          if (req.url === "/api/query/settings") return json({ onboarding_completed: false });
          if (req.url === "/api/query/ghStatus")
            return json({ isInstalled: true, isAuthenticated: true, login: "fixture-user" });
          if (req.url === "/api/query/agentAuth")
            return failAgentAuth
              ? json({}, 503)
              : json({
                  agents: [],
                  claude: {
                    type: "claude",
                    agentHarness: "claude-code",
                    accountInfo: { tokenSource: "none", apiProvider: "firstParty" },
                  },
                  codex: null,
                });
          if (req.url === "/api/query/session")
            return json({
              id: "history-session",
              agent_harness: "codex-app-server",
              status: "idle",
              workspace_kind: directHistory ? "cloud" : "local",
              provider_session_id: directHistory ? "provider-session" : null,
            });
          if (req.url === "/api/query/sessions")
            return json([
              ...["a", "b", "c", "d"].map((id) => ({
                id,
                agent_harness: "claude-code",
                message_count: id === "b" ? 1 : 0,
              })),
              ...createdSessions,
            ]);
          if (req.url === "/api/mutate/createSession") {
            const session = {
              id: `new-${createdSessions.length}`,
              agent_harness: "claude-code",
              message_count: 0,
            };
            createdSessions.push(session);
            return json({ success: true, data: session });
          }
          if (req.url === "/api/query/messages") {
            historyRequests++;
            return failHistory
              ? json({}, 503)
              : json({
                  messages: [],
                  compactions: [],
                  has_older: false,
                  has_newer: false,
                  turns: [
                    {
                      turnId: "saved-turn",
                      startedAt: 1,
                      execution: { harness: "codex-app-server", model: "gpt-5.6-sol" },
                    },
                  ],
                });
          }
          if (req.url === "/api/query/recentProjects")
            return failRecentProjects
              ? json({}, 503)
              : json({
                  projects: [{ name: "test-project", path: "/fixture/project", source: "cursor" }],
                });
          if (req.url === "/api/mutate/invalidateFileCache") return json({ success: true });
          if (req.url === "/api/mutate/addRepo")
            return json({ success: false, error: "not a git repository" });
          if (req.url === "/api/mutate/saveSetting")
            return json({
              success: !failFinishSetup,
              error: failFinishSetup ? "Disk is full" : undefined,
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
  for (const start of ["Start active chat", "Discover active chat"]) {
    await page.getByRole("button", { name: "Open Codex chat", exact: true }).click();
    await page.locator('output[data-model="codex-app-server:gpt-6-astra"]').waitFor();
    await page.getByRole("button", { name: "Choose Claude", exact: true }).click();
    await page.locator('output[data-harness="claude-code"]').waitFor();
    await page.getByRole("button", { name: start, exact: true }).click();
    await page.locator('output[data-model=""]').waitFor();
    await page.getByRole("button", { name: "Close active chat", exact: true }).click();
    await page.getByRole("button", { name: "Restore original chat", exact: true }).click();
    assert.equal(await labels.getAttribute("data-model"), "", "Started chats restore from history");
    assert.equal(await labels.getAttribute("data-harness"), "claude-code");
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
  // Exercise the real query retry: failed history must not seed the default model.
  await page.goto(server.resolvedUrls.local[0] + "?history");
  await page.getByRole("alert").filter({ hasText: "Couldn’t load this conversation." }).waitFor();
  assert.equal(await page.getByRole("textbox").count(), 0);
  const failedHistoryRequests = historyRequests;
  failHistory = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page
    .getByRole("button", { name: "Select model, currently GPT-5.6 Sol", exact: true })
    .waitFor();
  await page.getByRole("textbox").waitFor();
  assert.equal(historyRequests, failedHistoryRequests + 1, "Try again must refetch history");
  // Direct cloud history arrives only through the socket. An empty snapshot
  // must unlock the first prompt without an HTTP fallback or preseeded cache.
  directHistory = true;
  const beforeDirectHistory = historyRequests;
  await page.evaluate(() => localStorage.setItem("deus.cloudDirect", "1"));
  await page.reload();
  await page.getByText("Loading conversation…", { exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox").count(), 0);
  await page.evaluate(() => window.deliverEmptyCloudSnapshot());
  await page.getByRole("textbox").waitFor();
  assert.equal(historyRequests, beforeDirectHistory, "Direct history never fetches from the Mac");
  await page.evaluate(() => localStorage.removeItem("deus.cloudDirect"));
  directHistory = false;
  // First-run UI with native/transport boundaries, including recoverable failures.
  // The normal-profile credentials and filesystem are never used by this test.
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.addInitScript(() => {
    window.loginCommands = [];
    window.electronAPI = {
      invoke: async (command) =>
        command === "check_cli_tool"
          ? { installed: true, path: "/bundled/cli" }
          : command === "native:pickFolder"
            ? "/fixture/not-git"
            : undefined,
      openTerminal: async (command) => {
        window.loginCommands.push(command);
        return "opened";
      },
    };
  });
  await page.goto(server.resolvedUrls.local[0] + "?onboarding");
  await page.getByRole("button", { name: "Run Deus", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Connect GitHub", exact: true }).waitFor();
  await page.getByRole("button", { name: "Continue", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Skip", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Connect your AI tools", exact: true }).waitFor();
  const signIns = page.getByRole("button", { name: "Sign in", exact: true });
  await page.getByText("Couldn’t check account", { exact: true }).waitFor();
  assert.equal(await signIns.count(), 1, "A failed Claude probe must offer retry, not sign-in");
  failAgentAuth = false;
  await page.getByRole("button", { name: "Check again", exact: true }).first().click();
  await page.getByText("Sign in on this computer", { exact: true }).waitFor();
  assert.equal(await signIns.count(), 2, "The SDK no-credentials account is signed out");
  await signIns.first().click();
  await signIns.last().click();
  assert.deepEqual(await page.evaluate(() => window.loginCommands), [
    "claude auth login",
    "codex login",
  ]);
  assert.equal(await page.getByText("/bundled/cli", { exact: false }).count(), 0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Couldn’t load recent projects" }).waitFor();
  failRecentProjects = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  const project = page.getByRole("button", { name: /test-project/ });
  await project.waitFor();
  await project.click();
  assert.equal(await project.getAttribute("aria-pressed"), "true");
  await project.click();
  assert.equal(await project.getAttribute("aria-pressed"), "false");
  await page.getByRole("button", { name: "Browse Folder", exact: true }).click();
  await page
    .locator('[data-sonner-toast][data-type="error"]')
    .filter({ hasText: "git repository" })
    .waitFor();
  await page.getByRole("heading", { name: "Your Projects", exact: true }).waitFor();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t finish setup. Disk is full" })
    .waitFor();
  await page.screenshot({ path: path.join(artifacts, "onboarding-error.png") });
  failFinishSetup = false;
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[class*="transition-opacity"]')?.classList.contains("opacity-0")
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: GitHub form focus/Enter/cache hygiene, Cloud ownership, stable chat grouping/dimming, unique tab labels and model restoration, Files retry/reconnect/refresh failures, mobile layout/error recovery, conversation history retry and empty direct snapshot, and onboarding auth/login/project/finish recovery"
  );
} catch (err) {
  console.error("UI state:", await page?.locator("body").innerText());
  await page?.screenshot({ path: path.join(artifacts, "failure.png") });
  throw err;
} finally {
  await browser?.close();
  await server.close();
}
