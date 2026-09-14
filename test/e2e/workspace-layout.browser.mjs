/* global window, document, innerWidth, getComputedStyle */
// Real layout, chat, tool panels and store; only backend/native boundaries are fixtures.
// Run: bun test/e2e/workspace-layout.browser.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";
import { chromium } from "playwright";

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
import { MainContent } from "@/app/layouts/MainContent";
import { queryKeys } from "@/shared/api/queryKeys";
import { workspaceLayoutActions, useWorkspaceLayoutStore } from "@/features/workspace/store/workspaceLayoutStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { ConnectionIllustration } from "@/features/connection/ui/ConnectionIllustration";
import { Check } from "lucide-react";
import "@/global.css";
const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
const settings = {experimental_browser: true, experimental_simulator: true, experimental_apps: true};
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
 return <QueryClientProvider client={client}><TooltipProvider><SidebarProvider>
   <aside data-fixture-sidebar className="bg-bg-base h-screen w-64 shrink-0 p-4">Deus</aside>
   <MainContent selectedWorkspace={current as any} prStatus={null} ghStatus={{isInstalled:true,isAuthenticated:true} as any} workspaceChatPanelRef={chatRef}
     repos={[]} repoGroups={[]} onCreateWorkspace={()=>{}} onOpenProject={()=>{}} onCloneRepository={()=>{}} onStartNewProject={()=>{}} onStartWorkspace={()=>{}} onWorkspaceClick={()=>{}} />
   <div hidden data-custom-icons><Check className="stroke-[2.5]" /><ConnectionIllustration /></div>
 </SidebarProvider></TooltipProvider></QueryClientProvider>;
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
        export const sendRequest = async (name, params) => {const r=await fetch("/api/query/"+name,{method:"POST",body:JSON.stringify(params)});if(!r.ok)throw new Error("Files temporarily unavailable");return r.json();};
        export const sendMutate = async () => ({success:true});
        export const sendCommand = async () => ({accepted:true});
        export const onEvent = () => () => {};
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
              experimental_apps: true,
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
                  files: [{ name: "README.md", path: "README.md", type: "file" }],
                  totalFiles: 1,
                  totalSize: 25,
                })
              : json({}, 503);
          if (resource === "simulatorCapabilities") return json({ available: true });
          if (resource === "diffFiles") return json({ files: [] });
          if (resource === "local_servers")
            return json({ servers: [], isLoading: false, refreshedAt: null });
          if (req.url.includes("environment")) return json({ tasks: [] });
          if (resource === "ghStatus") return json({ isInstalled: true, isAuthenticated: true });
          if (req.url.includes("cloud")) return json({});
          return json([]);
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0 },
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
  const tabs = page.getByRole("tablist", { name: "Content panel" });
  const tab = (name) => tabs.getByRole("tab", { name, exact: true }).click();
  const composer = page.locator('[data-slot="workspace-chat-pane"] textarea');
  await composer.fill("Keep this draft while I inspect the workspace.");
  await page.evaluate(() => {
    window.originalComposer = document.querySelector('[data-slot="workspace-chat-pane"] textarea');
    window.originalContent = document.querySelector('[data-slot="workspace-content-pane"]');
  });
  await tabs.getByRole("tab", { name: "Simulator", exact: true }).waitFor();
  assert.deepEqual(
    await tabs.getByRole("tab").evaluateAll((es) => es.map((e) => e.getAttribute("aria-label"))),
    ["Changes", "Files", "Terminal", "Browser", "Simulator", "Apps", "Agent"]
  );
  assert.equal(await page.getByRole("button", { name: "More content tabs" }).count(), 0);
  const iconWeights = await page
    .locator('[data-slot="workspace-tool-header"] .lucide')
    .evaluateAll((es) => es.map((e) => getComputedStyle(e).strokeWidth));
  assert(iconWeights.length > 7 && iconWeights.every((w) => w === "1.5px"));
  assert.equal(
    await page
      .locator("[data-custom-icons] .lucide")
      .evaluate((e) => getComputedStyle(e).strokeWidth),
    "2.5px"
  );
  assert.equal(
    await page
      .locator('[data-custom-icons] svg:not(.lucide) [stroke-width="2.5"]')
      .first()
      .evaluate((e) => getComputedStyle(e).strokeWidth),
    "2.5px"
  );
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
  // Every tool hosts the same action, including its empty/loading/error body.
  for (const name of ["Files", "Terminal", "Browser", "Simulator", "Apps", "Agent"]) {
    await tab(name);
    await click("Expand workspace");
    await view("content");
    await click("Restore split");
    await view("split");
  }
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
  // View preferences survive reload; split widths and live terminal ids do not.
  await page.reload();
  await view("content");
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("workspace-layout-store"))
  );
  assert.equal(saved.state.layouts.first.panelMode, "content");
  assert.equal(saved.state.layouts.second.panelMode, "split");
  assert.deepEqual(saved.state.layouts.first.terminalTabs, []);
  assert(!("chatPanelCollapsed" in saved.state.layouts.first));
  await page.keyboard.press("Control+Backslash");
  await view("split");
  // A gated cloud computer still exposes Restore; no VM is provisioned by a layout action.
  await page.evaluate(() => window.setCloudStage("initializing"));
  for (const name of ["Changes", "Files", "Terminal", "Browser", "Simulator"]) {
    await tab(name);
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
  assert.equal(await page.getByRole("button", { name: "Show workspace", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real workspace views, seven tools, icon weights, split restoration, composer DOM/draft preservation, per-workspace state, cloud gates, Files retry, environment target, keyboard and responsive layouts"
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
