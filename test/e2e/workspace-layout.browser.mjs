/* global window, document, innerWidth, requestAnimationFrame */
// Real layout, chat, tool panels and store; only backend/native boundaries are fixtures.
// Run: bun test/e2e/workspace-layout.browser.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";
import { chromium } from "playwright";
import { freePort } from "./remote-access/stack.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const artifacts = path.join(root, ".context/workspace-layout-ui");
await mkdir(artifacts, { recursive: true });
await writeFile(
  path.join(artifacts, "entry.tsx"),
  `
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ThemeProvider } from "@/app/providers/ThemeProvider";
import { MainContent } from "@/app/layouts/MainContent";
import { queryKeys } from "@/shared/api/queryKeys";
import { workspaceLayoutActions, useWorkspaceLayoutStore } from "@/features/workspace/store/workspaceLayoutStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { ConnectionIllustration } from "@/features/connection/ui/ConnectionIllustration";
import { Check } from "lucide-react";
import "@/global.css";
const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
const settings = {experimental_browser: true, experimental_simulator: true};
client.setQueryData(queryKeys.settings.all, settings);
const workspace = {id:"first",repository_id:"repo",repo_name:"deus/app",title:"Workspace layout",kind:"local",state:"ready",workspace_path:"/fixture",root_path:"/fixture",current_session_id:"session",session_status:"idle",setup_status:"completed",status:"in-progress",git_branch:"layout",git_default_branch:"main",latest_message_sent_at:1};
window.layoutActions = workspaceLayoutActions;
window.layoutState = () => useWorkspaceLayoutStore.getState().layouts;
window.settingsTarget = () => useUIStore.getState().environmentSettingsTarget;
window.client = client;
function App() {
 const [current, setCurrent] = useState(workspace);
 const chatRef = useRef(null);
 window.selectWorkspace = id => setCurrent({...workspace,id});
 window.setCloudStage = state => setCurrent({...workspace,kind:"cloud",state,init_stage:state === "initializing" ? "resuming" : null,cloud_status: state === "ready" ? "running" : "paused"});
 return <ThemeProvider><QueryClientProvider client={client}><TooltipProvider><SidebarProvider>
   <aside data-fixture-sidebar className="bg-bg-base h-screen w-64 shrink-0 p-4">Deus</aside>
   <MainContent selectedWorkspace={current as any} prState={{type:"create_pr"}} workspaceChatPanelRef={chatRef}
     repos={[]} repoGroups={[]} onCreateWorkspace={()=>{}} onOpenProject={()=>{}} onCloneRepository={()=>{}} onStartNewProject={()=>{}} onStartWorkspace={()=>{}} onWorkspaceClick={()=>{}} />
   <div hidden data-custom-icons><Check className="stroke-[2.5]" /><ConnectionIllustration /></div>
 </SidebarProvider></TooltipProvider></QueryClientProvider></ThemeProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
`
);
let filesOnline = true;
const requests = [];
const server = await createServer({
  configFile: false,
  root,
  cacheDir: path.join(artifacts, "vite-cache"),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  optimizeDeps: { entries: [path.join(artifacts, "entry.tsx")] },
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
      name: "layout-boundaries",
      enforce: "pre",
      resolveId(id) {
        if (id.endsWith("/platform/ws") || id.endsWith("/platform/ws/query-protocol-client"))
          return "\0layout-ws";
        if (id.endsWith("config/api.config")) return "\0layout-api";
        if (id.endsWith("/platform/capabilities")) return "\0layout-capabilities";
      },
      load(id) {
        if (id === "\0layout-api")
          return `export const getBaseURL = async () => location.origin + "/api"; export const getBaseURLSync = () => location.origin + "/api"; export const getBackendUrl = async () => location.origin;`;
        if (id === "\0layout-capabilities")
          return `export * from ${JSON.stringify(path.join(root, "apps/web/src/platform/capabilities.ts"))}; export const capabilities = {nativeBrowser:true,browserProfileImport:false};`;
        if (id === "\0layout-ws")
          return `
        export * from ${JSON.stringify(path.join(root, "apps/web/src/platform/ws/index.ts"))};
        const sendRequest = async (name, params) => {const r=await fetch("/api/query/"+name,{method:"POST",body:JSON.stringify(params)});if(!r.ok)throw new Error("Files temporarily unavailable");return r.json();};
        export const call = async (op, input) => (op.kind === "read" ? sendRequest(op.name, input) : {});
        export const follow = () => () => {};
      `;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] === "/") {
            res.setHeader("content-type", "text/html");
            res.end(
              '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/.context/workspace-layout-ui/entry.tsx"></script></body></html>'
            );
            return;
          }
          if (!req.url?.startsWith("/api/")) return next();
          const json = (data, status = 200) => {
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(data));
          };
          requests.push(req.url);
          const resource = req.url.slice("/api/query/".length);
          if (resource === "settings")
            return json({
              experimental_browser: true,
              experimental_simulator: true,
            });
          if (resource === "session")
            return json({
              id: "session",
              agent_harness: "codex-app-server",
              status: "idle",
              workspace_kind: "local",
            });
          if (resource === "sessions")
            return json([{ id: "session", agent_harness: "codex-app-server", message_count: 1 }]);
          if (resource === "queuedMessages") return json({ paused: null, items: [] });
          if (resource === "messages")
            return json({
              messages: [],
              compactions: [],
              turns: [],
              has_older: false,
              has_newer: false,
            });
          if (resource === "workspaceFiles")
            return filesOnline
              ? json({
                  files: [
                    { name: "README.md", path: "README.md", type: "file" },
                    {
                      name: "src",
                      path: "src",
                      type: "directory",
                      children: [{ name: "App.tsx", path: "src/App.tsx", type: "file" }],
                    },
                  ],
                  totalFiles: 2,
                  totalSize: 120,
                })
              : json({}, 503);
          if (resource === "fileContent")
            return json({ content: "# Deus Machine\n\nWelcome to browser-style tabs.\n" });
          if (resource === "simulatorCapabilities") return json({ available: true });
          if (resource === "diffFiles") return json({ files: [] });
          if (resource === "localServers")
            return json({
              servers: [
                {
                  url: "http://localhost:1420",
                  host: "localhost",
                  port: 1420,
                  title: "Deus Web",
                  status: "running",
                  previewImageDataUrl: null,
                },
              ],
              isLoading: false,
              refreshedAt: Date.now(),
            });
          if (req.url.includes("environment")) return json({ tasks: [] });
          if (resource === "ghStatus") return json({ isInstalled: true, isAuthenticated: true });
          if (req.url.includes("cloud")) return json({});
          return json([]);
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: await freePort(), strictPort: true, watch: null },
});
let browser, page;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.stack);
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole("button", { name: "Hide workspace", exact: true }).waitFor();
  await page.getByRole("textbox").first().waitFor();
  const view = async (mode) => {
    await page.locator('[data-workspace-view="' + mode + '"]').waitFor();
    await page.waitForFunction((mode) => {
      const chat = document.getElementById("workspace-chat").getBoundingClientRect();
      const content = document.getElementById("workspace-content")?.getBoundingClientRect();
      return mode === "chat"
        ? !content || content.width < 1
        : mode === "content"
          ? chat.width < 1
          : chat.width > 100 && content.width > 100;
    }, mode);
  };
  const click = (name) => page.getByRole("button", { name, exact: true }).click();
  const tabs = page.getByRole("tablist", { name: "Workspace tabs" });
  const createPR = page.getByRole("button", { name: "Create PR", exact: true });
  const tab = (name) => tabs.getByRole("tab", { name, exact: true }).click();
  const addNewTab = () => page.getByRole("button", { name: "New tab", exact: true }).click();
  const openFromNewTab = async (label) => {
    const newTabView = page.locator('[data-slot="new-tab-view"]');
    if (!(await newTabView.isVisible())) {
      await addNewTab();
      await newTabView.waitFor();
    }
    await newTabView.getByRole("button", { name: label, exact: true }).click();
  };
  const composer = page.locator('[data-slot="workspace-chat-pane"] textarea');
  await composer.fill("Keep this draft while I inspect the workspace.");
  await page.evaluate(() => {
    window.originalComposer = document.querySelector('[data-slot="workspace-chat-pane"] textarea');
    window.originalContent = document.querySelector('[data-slot="workspace-content-pane"]');
  });
  // Fresh workspace opens on a clean New Tab with omnibox + tool cards + running servers.
  await tabs.getByRole("tab", { name: "New tab", exact: true }).waitFor();
  await page
    .locator('[data-slot="new-tab-view"]')
    .getByRole("button", { name: "Simulator", exact: true })
    .waitFor();
  assert.ok(await createPR.isVisible(), "the header shows the available PR action");
  assert.deepEqual(
    await tabs.getByRole("tab").evaluateAll((es) => es.map((e) => e.getAttribute("aria-label"))),
    ["New tab"]
  );
  await page.screenshot({ path: path.join(artifacts, "new-tab-light.png") });
  await page.evaluate(async () => {
    document.documentElement.classList.add("dark");
    await new Promise(requestAnimationFrame);
    await Promise.allSettled(document.getAnimations().map((a) => a.finished));
  });
  await page.screenshot({ path: path.join(artifacts, "new-tab-dark.png") });
  await page.evaluate(async () => {
    document.documentElement.classList.remove("dark");
    await new Promise(requestAnimationFrame);
    await Promise.allSettled(document.getAnimations().map((a) => a.finished));
  });

  // Omnibox combobox semantics + file search opens a dedicated file tab with rendered content.
  const omnibox = page.getByRole("combobox", { name: "Search files or enter a URL" });
  assert.equal(await omnibox.getAttribute("aria-expanded"), "false");
  const fileReads = () => requests.filter((url) => url === "/api/query/workspaceFiles").length;
  assert.equal(fileReads(), 0, "a cold New Tab has not requested the file tree");
  const filesReply = Promise.withResolvers();
  await page.route(
    "**/api/query/workspaceFiles",
    async (route) => {
      await filesReply.promise;
      await route.continue();
    },
    { times: 1 }
  );
  await Promise.all([page.waitForRequest("**/api/query/workspaceFiles"), omnibox.press("r")]);
  assert.equal(await omnibox.getAttribute("aria-expanded"), "true");
  await omnibox.press("ArrowDown");
  const browserOption = page.getByRole("option", { name: /^Browser/ });
  assert.equal(await browserOption.getAttribute("aria-selected"), "true");
  filesReply.resolve();
  const readme = page.getByRole("option").filter({ hasText: "README.md" });
  await readme.waitFor();
  assert.equal(fileReads(), 1, "the first keystroke requested the file tree");
  await page.screenshot({ path: path.join(artifacts, "new-tab-first-keystroke.png") });
  assert.equal(
    await omnibox.getAttribute("aria-activedescendant"),
    await browserOption.getAttribute("id")
  );
  await omnibox.press("Enter");
  await tabs.getByRole("tab", { name: "Browser", selected: true }).hover();
  await page.getByRole("button", { name: "Close Browser", exact: true }).click();
  await omnibox.fill("README");
  await readme.click();
  const readmeTab = tabs.getByRole("tab", { name: "README.md", exact: true });
  await readmeTab.waitFor();
  await page.getByText("Welcome to browser-style tabs.").waitFor();
  // Active tab aria-controls pairs with the visible tabpanel.
  const activeTabId = await readmeTab.getAttribute("id");
  const controlledPanelId = await readmeTab.getAttribute("aria-controls");
  const tabPanel = page.locator(`[role="tabpanel"][id="${controlledPanelId}"]`);
  assert.equal(await tabPanel.getAttribute("aria-labelledby"), activeTabId);

  // Open a second tab and verify aria-controls is only set on the active mounted tabpanel,
  // plus 2-tab drag-and-drop reorder works symmetrically.
  await openFromNewTab("Changes");
  const changesTab = tabs.getByRole("tab", { name: "Changes", exact: true });
  await changesTab.waitFor();
  assert.equal(
    await readmeTab.getAttribute("aria-controls"),
    null,
    "inactive tabs omit aria-controls when their tabpanel is not mounted"
  );
  assert.ok(
    await changesTab.getAttribute("aria-controls"),
    "active tab sets aria-controls to its mounted tabpanel"
  );
  const tabLabels = () =>
    tabs.getByRole("tab").evaluateAll((es) => es.map((e) => e.getAttribute("aria-label")));
  assert.deepEqual(await tabLabels(), ["README.md", "Changes"]);
  const readmeBox = await readmeTab.boundingBox();
  const changesBox = await changesTab.boundingBox();
  await page.mouse.move(changesBox.x + changesBox.width / 2, changesBox.y + changesBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(readmeBox.x + readmeBox.width * 0.25, readmeBox.y + readmeBox.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  assert.deepEqual(await tabLabels(), ["Changes", "README.md"]);
  await page.screenshot({ path: path.join(artifacts, "split.png") });
  // Resize once; hide/show and focus/restore must preserve the chosen ratio.
  const separator = page.locator('[data-workspace-view] > [data-slot="resizable-handle"]');
  const bounds = await separator.boundingBox();
  await page.mouse.move(bounds.x, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 50, bounds.y + 100, { steps: 8 });
  await page.mouse.up();
  const width = await page
    .locator("#workspace-chat")
    .evaluate((e) => e.getBoundingClientRect().width);
  await click("Hide workspace");
  await view("chat");
  assert.equal(
    await page
      .locator('#workspace-content [data-slot="workspace-content-pane"]')
      .getAttribute("inert"),
    ""
  );
  await page.getByRole("complementary", { name: "Workspace tools" }).waitFor();
  const headerButtons = await page
    .locator('[data-slot="workspace-header"] button')
    .evaluateAll((es) => es.map((e) => e.getAttribute("aria-label")));
  assert.equal(headerButtons.at(-1), "Show workspace");
  await page.screenshot({ path: path.join(artifacts, "chat.png") });
  await click("Show workspace");
  await view("split");
  assert(
    Math.abs(
      (await page.locator("#workspace-chat").evaluate((e) => e.getBoundingClientRect().width)) -
        width
    ) < 2
  );
  await click("Expand workspace");
  await view("content");
  assert.equal(await page.locator('[data-slot="workspace-header"]').isVisible(), false);
  assert.equal(await page.locator("[data-fixture-sidebar]").isVisible(), true);
  await page.screenshot({ path: path.join(artifacts, "content.png") });
  await click("Restore split");
  await view("split");
  assert(
    Math.abs(
      (await page.locator("#workspace-chat").evaluate((e) => e.getBoundingClientRect().width)) -
        width
    ) < 2
  );
  assert.equal(await composer.inputValue(), "Keep this draft while I inspect the workspace.");
  assert(
    await page.evaluate(
      () =>
        window.originalComposer ===
          document.querySelector('[data-slot="workspace-chat-pane"] textarea') &&
        window.originalContent === document.querySelector('[data-slot="workspace-content-pane"]')
    )
  );
  // Every tool can be opened from New Tab and supports expand/restore from the unified tab bar.
  for (const name of ["Files", "Terminal", "Browser", "Simulator", "Agent"]) {
    await openFromNewTab(name);
    await click("Expand workspace");
    await view("content");
    await click("Restore split");
    await view("split");
  }
  await page.evaluate(async () => {
    document.documentElement.classList.add("dark");
    await new Promise(requestAnimationFrame);
    await Promise.allSettled(document.getAnimations().map((a) => a.finished));
  });
  await page.screenshot({ path: path.join(artifacts, "multi-tabs-dark.png") });
  await page.evaluate(async () => {
    document.documentElement.classList.remove("dark");
    await new Promise(requestAnimationFrame);
    await Promise.allSettled(document.getAnimations().map((a) => a.finished));
  });

  await tab("Files");
  await page.getByRole("treeitem", { name: "README.md", exact: true }).waitFor();
  filesOnline = false;
  await page.evaluate(() => window.client.invalidateQueries({ queryKey: ["files", "first"] }));
  await page.getByRole("alert").filter({ hasText: "Files temporarily unavailable" }).waitFor();
  await click("Expand workspace");
  await view("content");
  await click("Restore split");
  await view("split");
  filesOnline = true;
  await click("Try again");
  await page.getByRole("treeitem", { name: "README.md", exact: true }).waitFor();
  await click("Hide workspace");
  await view("chat");
  await page.evaluate(() => window.layoutActions.setActiveContentTab("first", "browser"));
  await view("chat");
  await click("Files");
  await view("split");
  // Launcher isolation across workspaces, Delete-key close + focus restore, and rapid same-pixel close.
  await page.evaluate(() => window.selectWorkspace("rapid"));
  const rapidOmnibox = page.getByRole("combobox", { name: "Search files or enter a URL" });
  await rapidOmnibox.fill("should-not-leak");
  await page.evaluate(() => window.selectWorkspace("second"));
  assert.equal(
    await page.getByRole("combobox", { name: "Search files or enter a URL" }).inputValue(),
    "",
    "launcher omnibox input must not leak across workspaces"
  );
  await page.evaluate(() => window.selectWorkspace("rapid"));
  for (const name of ["Changes", "Files", "Agent", "Terminal"]) {
    await openFromNewTab(name);
  }
  assert.deepEqual(await tabLabels(), ["Changes", "Files", "Agent", "Terminal 1"]);
  // Delete key closes the focused tab and restores focus to a surviving tab.
  const agentTab = tabs.getByRole("tab", { name: "Agent", exact: true });
  await agentTab.focus();
  await page.keyboard.press("Delete");
  assert.deepEqual(await tabLabels(), ["Changes", "Files", "Terminal 1"]);
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("role")),
    "tab",
    "Delete close restores focus to a surviving tab"
  );
  // Ctrl+W inside the workspace pane closes the active tab with the same focus restoration.
  await tabs.getByRole("tab", { name: "Terminal 1", exact: true }).click();
  await tabs.getByRole("tab", { name: "Terminal 1", exact: true }).focus();
  await page.keyboard.press("Control+w");
  assert.deepEqual(await tabLabels(), ["Changes", "Files"]);
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("role")),
    "tab",
    "workspace Ctrl+W restores focus to a surviving tab"
  );
  // Closing a tab adjacent to a hidden tab selects AND focuses the same visible successor.
  await openFromNewTab("Browser");
  await openFromNewTab("Agent");
  await page.evaluate(() => {
    window.client.setQueryData(["settings"], {
      experimental_browser: false,
      experimental_simulator: true,
    });
  });
  await page.waitForFunction(() => {
    const labels = [
      ...document.querySelectorAll('[role="tablist"][aria-label="Workspace tabs"] [role="tab"]'),
    ]
      .filter((e) => !e.closest("[inert]"))
      .map((e) => e.getAttribute("aria-label"));
    return (
      labels.length === 3 &&
      labels[0] === "Changes" &&
      labels[1] === "Files" &&
      labels[2] === "Agent"
    );
  });
  // Full strip is [Changes, Files, hidden Browser, Agent]; closing Files via Ctrl+W must
  // select, display, AND focus Agent (not Changes).
  await tabs.getByRole("tab", { name: "Files", exact: true }).click();
  await tabs.getByRole("tab", { name: "Files", exact: true }).focus();
  await page.keyboard.press("Control+w");
  assert.deepEqual(await tabLabels(), ["Changes", "Agent"]);
  const agentAfterClose = tabs.getByRole("tab", { name: "Agent", exact: true });
  assert.equal(
    await agentAfterClose.getAttribute("aria-selected"),
    "true",
    "Ctrl+W with a hidden neighbor selects the visible successor Agent"
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    "Agent",
    "Ctrl+W with a hidden neighbor focuses the same visible successor Agent"
  );
  const agentPanelId = await agentAfterClose.getAttribute("aria-controls");
  assert.equal(
    await page.locator(`[role="tabpanel"][id="${agentPanelId}"]`).getAttribute("aria-labelledby"),
    await agentAfterClose.getAttribute("id"),
    "displayed tabpanel matches the selected and focused successor Agent"
  );
  await page.evaluate(() => {
    window.client.setQueryData(["settings"], {
      experimental_browser: true,
      experimental_simulator: true,
    });
  });
  await tabs.getByRole("tab", { name: "Browser", exact: true }).waitFor();
  assert.deepEqual(await tabLabels(), ["Changes", "Browser", "Agent"]);
  // Rapid close-clicking at the exact same pixel closes uniform-width tabs consecutively.
  const firstTab = tabs.getByRole("tab", { name: "Changes", exact: true });
  await firstTab.hover();
  const closeBox = await page
    .getByRole("button", { name: "Close Changes", exact: true })
    .boundingBox();
  const cx = closeBox.x + closeBox.width / 2;
  const cy = closeBox.y + closeBox.height / 2;
  await page.mouse.click(cx, cy);
  assert.deepEqual(await tabLabels(), ["Browser", "Agent"]);
  await page.mouse.click(cx, cy);
  assert.deepEqual(await tabLabels(), ["Agent"]);
  await page.mouse.click(cx, cy);
  assert.deepEqual(await tabLabels(), ["New tab"]);
  await page.evaluate(() => window.selectWorkspace("first"));

  // Per-workspace views are independent; returning must not overwrite a saved mode.
  await click("Expand workspace");
  await view("content");
  await page.evaluate(() => window.selectWorkspace("second"));
  await view("split");
  await page.evaluate(() => window.selectWorkspace("first"));
  await view("content");
  await click("Hide workspace");
  await view("chat");
  await click("Environment");
  assert.deepEqual(await page.evaluate(() => window.settingsTarget()), {
    repoId: "repo",
    location: "local",
  });
  // Keyboard controls use the same three views.
  await page.keyboard.press("Control+]");
  await view("split");
  await page.keyboard.press("Control+Backslash");
  await view("content");
  // View preferences survive reload; split widths and live terminal tabs do not.
  await page.reload();
  await view("content");
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("workspace-layout-store"))
  );
  assert.equal(saved.state.layouts.first.panelMode, "content");
  assert.equal(saved.state.layouts.second.panelMode, "split");
  assert.equal(
    saved.state.layouts.first.workspaceTabs.some((t) => t.kind === "terminal"),
    false,
    "live terminal tabs are never persisted"
  );
  assert(!("chatPanelCollapsed" in saved.state.layouts.first));
  await page.keyboard.press("Control+Backslash");
  await view("split");
  // A gated cloud computer still exposes Restore; no VM is provisioned by a layout action.
  await page.evaluate(() => window.setCloudStage("initializing"));
  for (const name of ["Changes", "Files", "Terminal", "Browser", "Simulator"]) {
    await openFromNewTab(name);
    await page
      .getByText("Setting up your computer…", { exact: true })
      .filter({ visible: true })
      .waitFor();
    await click("Expand workspace");
    await view("content");
    await click("Restore split");
    await view("split");
  }
  // Narrow desktop headers stay within the pane, without an overflow menu.
  await page.setViewportSize({ width: 1050, height: 800 });
  await tab("Changes");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(artifacts, "narrow.png") });
  // Mobile uses its existing layout, with no desktop visibility controls.
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Hide workspace", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(await page.locator("[data-workspace-view]").count(), 0);
  assert.ok(await createPR.isVisible(), "the phone shows the available PR action");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Hosted web has no content tools; even a saved focused mode must leave chat usable.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    localStorage.setItem("deus.cloudDirectWeb", "1");
    window.layoutActions.setPanelMode("first", "content");
    window.setCloudStage("ready");
  });
  await view("chat");
  assert.equal(await page.locator("#workspace-content").count(), 0);
  assert.equal(await createPR.count(), 0, "the hosted chat-only header has no PR controls");
  assert.equal(await page.getByRole("button", { name: "Show workspace", exact: true }).count(), 0);

  // Rapid same-pixel close with motion ENABLED (50ms intervals during exit animation).
  const motionPage = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "no-preference",
  });
  motionPage.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.stack);
  });
  await motionPage.goto(server.resolvedUrls.local[0]);
  const motionTabs = motionPage.getByRole("tablist", { name: "Workspace tabs" });
  const motionNewTab = motionPage.locator('[data-slot="new-tab-view"]');
  await motionTabs.getByRole("tab", { name: "New tab", exact: true }).waitFor();
  for (const label of ["Changes", "Files", "Agent"]) {
    if (!(await motionNewTab.isVisible())) {
      await motionPage.getByRole("button", { name: "New tab", exact: true }).click();
      await motionNewTab.waitFor();
    }
    await motionNewTab.getByRole("button", { name: label, exact: true }).click();
  }
  const motionLabels = () =>
    motionTabs
      .locator('[role="tab"]:not([aria-hidden="true"])')
      .evaluateAll((es) =>
        es.filter((e) => !e.closest("[inert]")).map((e) => e.getAttribute("aria-label"))
      );
  assert.deepEqual(await motionLabels(), ["Changes", "Files", "Agent"]);
  const motionFirst = motionTabs.getByRole("tab", { name: "Changes", exact: true });
  await motionFirst.hover();
  const motionCloseBox = await motionPage
    .getByRole("button", { name: "Close Changes", exact: true })
    .boundingBox();
  const mx = motionCloseBox.x + motionCloseBox.width / 2;
  const my = motionCloseBox.y + motionCloseBox.height / 2;
  await motionPage.mouse.click(mx, my);
  await motionPage.waitForTimeout(50);
  await motionPage.mouse.click(mx, my);
  await motionPage.waitForTimeout(50);
  await motionPage.mouse.click(mx, my);
  await motionPage.waitForFunction(() => {
    const active = [
      ...document.querySelectorAll('[role="tablist"][aria-label="Workspace tabs"] [role="tab"]'),
    ]
      .filter((e) => !e.closest("[inert]"))
      .map((e) => e.getAttribute("aria-label"));
    return active.length === 1 && active[0] === "New tab";
  });
  assert.deepEqual(await motionLabels(), ["New tab"]);
  await motionPage.close();

  assert.deepEqual(errors, []);
  console.log(
    "PASS: real workspace views, six tools, icon weights, split restoration, composer DOM/draft preservation, per-workspace state, cloud gates, Files retry, environment target, keyboard and responsive layouts"
  );
} catch (error) {
  console.error("UI", await page?.locator("body").innerText());
  console.error("REQUESTS", [...new Set(requests)]);
  await page?.screenshot({ path: path.join(artifacts, "failure.png") });
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
