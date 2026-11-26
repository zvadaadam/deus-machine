/* global document, getComputedStyle, requestAnimationFrame, window */
// The composer's one picker for agent, model and thinking effort, with the
// engine's own catalog: the real component, driven by mouse, keyboard and at a
// phone's width.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../..");
const artifacts = path.join(root, ".context/model-picker-ui");
await mkdir(artifacts, { recursive: true });
await writeFile(
  path.join(artifacts, "entry.tsx"),
  `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ModelPicker } from "@/features/session/ui/model-picker/ModelPicker";
import { gatewayThinking } from "@shared/gateways";
import { CATALOG_MODEL_LISTS, fitThinkingLevel, modelThinkingLevels, parseModelValue } from "@shared/models";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GatewaysSection } from "@/features/settings/ui/sections/GatewaysSection";
import type { ThinkingLevel } from "@shared/protocol";
import { useNewChatSelection } from "@/features/repository/ui/composer/useNewChatSelection";
import { queryKeys } from "@/shared/api/queryKeys";
import { useKeyboardShortcuts } from "@/shared/hooks/useKeyboardShortcuts";
import { useUIStore } from "@/shared/stores/uiStore";
import "@/global.css";
const gateway = { ref:"fixture-gateway",preset:"cliproxyapi",formats:["messages","responses"],revision:"revision", baseUrl:"http://localhost", models:[
  {id:"work:one",label:"GPT 6.2 Astra",provider:"openai",runner:"codex-app-server",thinkingByFormat:{responses:{levels:["medium","high"],default:"medium"}}},
  {id:"same-family",label:"GPT Terra",provider:"openai",runner:"codex-app-server"},
  {id:"claude-a",label:"Claude Sonnet",provider:"anthropic",runner:"claude-code",thinkingByFormat:{messages:{levels:["low","high"],default:"high"}}},
  {id:"hidden-image",label:"Hidden image",provider:"openai",excluded:"hidden"},{id:"unknown-alias",label:"Unknown alias",provider:"other"}
]};
const levelsOf = (value: string) => {
  const pick=parseModelValue(value);
  if(pick?.gatewayRevision) return gatewayThinking(gateway.models.find(m=>m.id===pick.model),pick.harness)?.levels ?? [];
  const { harness, model } = parseModelValue(value)!;
  return modelThinkingLevels(CATALOG_MODEL_LISTS, harness, model);
};
const client=new QueryClient();
const params = new URLSearchParams(location.search);
if (params.has("identity")) gateway.revision = "a986d995-65dd-450c-a136-dbafe4459326";
if (params.has("settings")) client.setQueryData(["gateways"], [gateway,...(params.has("two")?[{...gateway,ref:"router",preset:"openrouter",revision:"router",baseUrl:"https://openrouter.ai/api"}]:[])]);
if (params.has("homePreference")) {
  localStorage.setItem("deus.cloudDirectWeb", "1");
  client.setQueryData(queryKeys.settings.all, {default_thinking_level: "high"});
  client.setQueryData([...queryKeys.settings.agentModels, null], {lists: CATALOG_MODEL_LISTS});
}
function HomeSelection() {
  const selection = useNewChatSelection("local");
  return <ModelPicker {...selection} hasMessages={false} onModelChange={selection.setModel} onThinkingLevelChange={selection.setThinkingLevel} />;
}
window.uiState = useUIStore.getState;
function App() {
  if (params.has("homePreference")) return <QueryClientProvider client={client}><HomeSelection /></QueryClientProvider>;
  if(params.has("settings")) return <QueryClientProvider client={client}><GatewaysSection local={true} checking={false} recheck={async()=>{window.catalogReads=(window.catalogReads??0)+1;}}/></QueryClientProvider>;
  useKeyboardShortcuts({onRefresh: async () => {}});
  const [model, setModel] = useState(params.get("model")!);
  const [level, setLevel] = useState(params.get("level") as ThinkingLevel);
  const [lastPick, setLastPick] = useState<{kind: string; args: (string | undefined)[]}>({kind:"",args:[]});
  const [opened, setOpened] = useState("");
  const [openedLevel, setOpenedLevel] = useState("");
  const [connected,setConnected]=useState(params.has("gateway"));
  React.useEffect(()=>{
    const disconnect=()=>setConnected(false);
    window.addEventListener("disconnect-gateway",disconnect);
    return ()=>window.removeEventListener("disconnect-gateway",disconnect);
  },[]);
  const levels = levelsOf(model);
  const offered = params.has("empty") ? [] : gateway.models.filter(m=>!params.has("codexOnly") || m.runner === "codex-app-server");
  if (params.has("mixed")) offered.push({id:"kimi:one",label:"Kimi K3",provider:"kimi",runner:"claude-code"});
  if (params.has("identity")) offered.push(...["Work:One","work:one:other"].map(id=>({id,label:"Shared",provider:"copilot",runner:"codex-app-server"})));
  const extra = params.has("many") ? Array.from({length:16},(_,i)=>({...gateway,preset:"custom",ref:"extra-"+i,revision:"extra-"+i,baseUrl:"https://gateway-"+i+".example",models:offered})):[];
  const second = params.has("samePreset") ? {...gateway,ref:"office",revision:"other",baseUrl:"http://localhost:8318",models:offered} : {...gateway,ref:"router",revision:"other",preset:"openrouter",models:offered};
  const below = params.has("home");
  return <main className={"bg-background text-foreground flex min-h-screen flex-col items-start p-4 " + (below ? "justify-start" : "justify-end")}>
    <output data-pick={lastPick.kind} data-pick-args={JSON.stringify(lastPick.args)} data-model={model} data-level={level} data-opened={opened} data-opened-level={openedLevel} />
    <ModelPicker side={below ? "bottom" : "top"} model={model} agentHarness={parseModelValue(model)!.harness} lists={CATALOG_MODEL_LISTS} gateways={connected?[{...gateway,models:offered},...extra,...(params.has("two")?[second]:[])]:[]}
      thinkingLevel={fitThinkingLevel(level, levels, "high")}
      previousGateway={params.has("started") && parseModelValue(model)?.gatewayRevision ? {ref:gateway.ref,label:"CLIProxyAPI"} : undefined}
      hasMessages={params.has("started")}
      onModelChange={({value}, ...levelArgs) => {
        const [effort] = levelArgs;
        setLastPick({kind:"model", args:[value, ...levelArgs]});
        setModel(value);
        setLevel((current) => effort ?? fitThinkingLevel(current, levelsOf(value), "high"));
      }}
      onThinkingLevelChange={(next) => {setLastPick({kind:"level",args:[next]}); setLevel(next);}} onOpenNewTab={params.has("locked") ? undefined : (value, level) => { setLastPick({kind:"new chat",args:[value,level]}); setOpened(value ?? ""); setOpenedLevel(level ?? ""); }} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<TooltipProvider><App /></TooltipProvider>);
`
);
const server = await createServer({
  configFile: false,
  envFile: false,
  root,
  cacheDir: path.join(artifacts, "vite-cache"),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  optimizeDeps: { entries: [path.join(artifacts, "entry.tsx")] },
  resolve: {
    alias: { "@": path.join(root, "apps/web/src"), "@shared": path.join(root, "shared") },
  },
  plugins: [
    tailwindcss(),
    svgr(),
    {
      name: "model-picker-page",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/" && !req.url.startsWith("/?")) return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="root"></main><script type="module" src="/.context/model-picker-ui/entry.tsx"></script></body></html>'
          );
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const errors = [];
  const cases = [];
  const visit = async (query, viewport = { width: 1024, height: 768 }, hasTouch = false) => {
    cases.push(query);
    const page = await browser.newPage({ viewport, hasTouch });
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    await page.goto(`${base}/?${query}`);
    const trigger = page.getByRole("button", { name: /^Select model, currently/ });
    await trigger.waitFor().catch((error) => {
      throw new Error([query, ...errors].join("\n"), { cause: error });
    });
    const menu = page.getByRole("dialog", { name: "Model and thinking effort" });
    return {
      page,
      trigger,
      menu,
      state: page.locator("output"),
      open: async (keyboard = false) => {
        if (keyboard) {
          await trigger.focus();
          await page.keyboard.press("Enter");
        } else if (hasTouch) await trigger.tap();
        else await trigger.click();
        await menu.waitFor();
        // Measurements wait for the menu to finish arriving.
        await menu.evaluate((node) => Promise.all(node.getAnimations().map((a) => a.finished)));
      },
      closed: () => menu.waitFor({ state: "detached" }),
      named: (name) => trigger.and(page.getByRole("button", { name, exact: true })).waitFor(),
    };
  };

  let chat = await visit("model=claude-code:opus&level=xhigh");
  const rail = () => chat.menu.getByRole("tablist", { name: "Account sources" });
  const agents = () => chat.menu.getByRole("tablist", { name: "Agents" });
  const tab = (group, name) => group().getByRole("tab", { name, exact: true });
  const search = () => chat.menu.getByRole("combobox", { name: "Search models" });
  const list = () => chat.menu.getByRole("listbox", { name: "Models" });
  const row = (name) => list().getByRole("option", { name, exact: true });
  const active = () => list().getByRole("option", { selected: true });
  const effort = (name) => chat.menu.getByRole("radio", { name, exact: true });
  const checkFocus = (locator) => locator.and(chat.page.locator(":focus")).waitFor();
  const key = (name) => chat.page.keyboard.press(name);
  const tabNames = (group) => group().getByRole("tab").allTextContents();
  const state = (field) => chat.state.getAttribute("data-" + field);
  const pickArgs = async () => JSON.parse(await state("pick-args"));
  const checkActive = (name) => active().and(row(name)).waitFor();
  async function checkGlide() {
    const fill = list().locator('[data-slot="glide"][data-lit]');
    await fill.waitFor();
    await fill.evaluate(async (el) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.allSettled(el.getAnimations().map((a) => a.finished));
    });
    const [paint, option] = await Promise.all([fill.boundingBox(), active().boundingBox()]);
    for (const field of ["x", "y", "width", "height"])
      assert(Math.abs(paint[field] - option[field]) <= 1);
  }
  const escape = async () => {
    await key("Escape");
    await chat.closed();
    await checkFocus(chat.trigger);
  };
  const phone = { width: 390, height: 720 };
  const claudeLevels = ["Low", "Medium", "High", "Extra high", "Max"];

  await chat.named("Select model, currently Opus 5.5, thinking Extra high");
  assert.equal((await chat.trigger.innerText()).replace(/\s+/g, " "), "Opus 5.5 Extra high");
  await chat.open(true);
  await checkFocus(search());
  await checkActive("Opus 5.5");
  assert.equal(await rail().count(), 0);
  assert.deepEqual(await tabNames(agents), ["Claude Code", "Codex", "Gemini"]);
  assert.equal((await chat.menu.boundingBox()).width, 384);
  assert.deepEqual(await list().getByRole("option").allTextContents(), [
    "Opus 5.5",
    "Fable 5.2",
    "Sonnet 5.5",
    "Haiku 5.5",
    "Fable 5.1",
    "Haiku 4.5",
    "Sonnet 5",
    "Opus 5",
    "Fable 5",
    "Opus 4.8",
    "Opus 4.7",
    "Opus 4.6",
    "Sonnet 4.6",
  ]);
  const levels = chat.menu.getByRole("radiogroup", { name: "Thinking effort" }).getByRole("radio");
  assert.deepEqual(await levels.allTextContents(), claudeLevels);
  assert.deepEqual(
    await levels.evaluateAll((items) => items.map((i) => i.getAttribute("aria-checked"))),
    ["false", "false", "false", "true", "false"]
  );
  const left = (locator) =>
    locator.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().left;
    });
  assert(
    Math.abs(
      (await left(chat.menu.getByText("Low", { exact: true }))) -
        (await left(chat.menu.getByText("Thinking", { exact: true })))
    ) < 1
  );
  await key("ArrowDown");
  await checkActive("Fable 5.2");
  await checkFocus(search());
  for (const level of claudeLevels) {
    await key("Tab");
    await checkFocus(effort(level));
  }
  await key("Space");
  await chat.closed();
  await chat.named("Select model, currently Opus 5.5, thinking Max");
  assert.equal(await state("pick"), "level");
  await checkFocus(chat.trigger);
  await chat.open(true);
  await key("Shift+Tab");
  await checkFocus(tab(agents, "Claude Code"));
  await key("ArrowRight");
  await checkFocus(tab(agents, "Codex"));
  await row("GPT-6.1-Sol").waitFor();
  assert.equal(await state("model"), "claude-code:opus");
  await key("Tab");
  await checkFocus(search());
  await chat.page.keyboard.type("GPT-5.5");
  await key("Enter");
  await chat.closed();
  await chat.named("Select model, currently GPT-5.5, thinking Extra high");
  assert.deepEqual(await pickArgs(), ["codex-app-server:gpt-5.5"]);
  assert.equal(await state("model"), "codex-app-server:gpt-5.5");
  await chat.open();
  await tab(agents, "Claude Code").click();
  await row("Haiku 4.5").click();
  await chat.closed();
  await chat.named("Select model, currently Haiku 4.5");
  await chat.open();
  await checkActive("Haiku 4.5");
  await chat.menu.getByText("Haiku 4.5 has no thinking control.", { exact: true }).waitFor();
  assert.equal(await chat.menu.getByRole("radio").count(), 0);
  await row("Sonnet 4.6").hover();
  await checkActive("Sonnet 4.6");
  await checkGlide();
  assert(await list().evaluate((el) => el.scrollTop > 0));
  await escape();
  await chat.page.close();

  // Click the original Max coordinates after crossing model rows, without retargeting the button.
  for (const placement of ["home", "chat"]) {
    chat = await visit("model=claude-code:opus&level=high&" + placement);
    await chat.open();
    assert.equal(
      await chat.menu.getAttribute("data-side"),
      placement === "home" ? "bottom" : "top"
    );
    const [chip, max] = await Promise.all([
      chat.trigger.boundingBox(),
      effort("Max").boundingBox(),
    ]);
    await chat.page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
    const x = max.x + max.width / 2,
      y = max.y + max.height / 2;
    await chat.page.mouse.move(x, y, { steps: 45 });
    assert.notEqual(await active().textContent(), "Opus 5.5");
    assert.deepEqual(await chat.menu.getByRole("radio").allTextContents(), claudeLevels);
    await chat.page.mouse.click(x, y);
    await chat.closed();
    await chat.named("Select model, currently Opus 5.5, thinking Max");
    assert.equal(await state("pick"), "level");
    await chat.page.close();
  }

  chat = await visit("model=claude-code:sonnet&level=high&started");
  await chat.open();
  await checkActive("Sonnet 5.5");
  await tab(agents, "Codex").click();
  await chat.menu.getByText("Opens a new chat", { exact: true }).waitFor();
  await row("GPT-6-Astra").click();
  await chat.closed();
  assert.equal(await state("model"), "claude-code:sonnet");
  assert.equal(await state("opened"), "codex-app-server:gpt-6-astra");
  assert.equal(await state("opened-level"), "high");
  await chat.page.close();

  for (const parameters of ["", "&gateway"]) {
    chat = await visit("model=claude-code:opus&level=xhigh&started&locked" + parameters);
    await chat.open();
    if (parameters) await tab(rail, "CLIProxyAPI").click();
    else await tab(agents, "Codex").click();
    await chat.menu.getByText("This chat keeps its agent", { exact: true }).waitFor();
    const unavailable = list().getByRole("option");
    assert((await unavailable.count()) > 0);
    assert(
      await unavailable.evaluateAll((rows) =>
        rows.every((row) => row.getAttribute("aria-disabled") === "true")
      )
    );
    await search().press("Enter");
    await chat.menu.waitFor();
    assert.equal(await state("pick"), "");
    await effort("Max").click();
    await chat.closed();
    await chat.named("Select model, currently Opus 5.5, thinking Max");
    await chat.page.close();
  }

  chat = await visit("model=claude-code:opus&level=high&gateway&mixed");
  await chat.open(true);
  await checkFocus(search());
  assert.deepEqual(await tabNames(rail), ["", ""]);
  assert.equal(await rail().getByRole("separator").count(), 1);
  await key("Shift+Tab");
  await checkFocus(tab(agents, "Claude Code"));
  await key("Shift+Tab");
  await checkFocus(tab(rail, "Your subscriptions"));
  const gateway = tab(rail, "CLIProxyAPI");
  await key("ArrowDown");
  await checkFocus(gateway);
  assert.equal(await gateway.getAttribute("aria-selected"), "true");
  await key("Tab");
  await checkFocus(tab(agents, "Claude Code"));
  await list().getByRole("group", { name: "Anthropic" }).waitFor();
  await list().getByRole("group", { name: "Kimi" }).waitFor();
  assert.equal(await row("GPT 6.2 Astra").count(), 0);
  await key("ArrowRight");
  await checkFocus(tab(agents, "Codex"));
  assert.deepEqual(await tabNames(agents), ["Claude Code", "Codex"]);
  assert.equal(await row("Claude Sonnet").count(), 0);
  assert.equal(await chat.menu.getByText("OpenAI", { exact: true }).count(), 0);
  assert.equal(await chat.menu.getByText(/^via /).count(), 0);
  await key("Tab");
  await checkFocus(search());
  for (const query of ["Astra", "work:one", "OpenAI"]) {
    await search().fill(query);
    await row("GPT 6.2 Astra").waitFor();
  }
  await row("GPT Terra").waitFor(); // The second row has the same provider.
  for (const query of ["gateway", "asr", "absent"]) {
    await search().fill(query);
    await chat.menu.getByText("No matching models.", { exact: true }).waitFor();
    assert.equal(await list().getByRole("option").count(), 0);
  }
  assert.deepEqual(await tabNames(agents), ["Claude Code", "Codex"]);
  await search().fill("work:one");
  await search().evaluate((el) => el.setSelectionRange(1, 1));
  await key("ArrowRight");
  await checkFocus(search());
  assert.equal(await search().evaluate((el) => el.selectionStart), 2);
  await key("ArrowLeft");
  assert.equal(await search().evaluate((el) => el.selectionStart), 1);
  await key("End");
  await key("Home");
  await checkActive("GPT 6.2 Astra");
  await search().fill("OpenAI");
  await checkActive("GPT 6.2 Astra");
  await key("End");
  await checkActive("GPT 6.2 Astra");
  await key("ArrowDown");
  await checkActive("GPT Terra");
  await checkFocus(search());
  await key("Home");
  await checkActive("GPT Terra");
  await key("Control+p");
  await checkActive("GPT Terra");
  await search().evaluate((el) => el.setSelectionRange(2, 2));
  await key("Control+k");
  assert.equal(await chat.page.evaluate(() => window.uiState().commandPaletteOpen), false);
  await tab(rail, "Your subscriptions").click();
  assert.equal(await search().inputValue(), "");
  assert.equal(await tab(agents, "Codex").getAttribute("aria-selected"), "true");
  await search().fill("absent");
  await tab(agents, "Claude Code").click();
  assert.equal(await search().inputValue(), "");
  await row("Haiku 4.5").hover();
  await checkActive("Haiku 4.5");
  assert.deepEqual(await chat.menu.getByRole("radio").allTextContents(), claudeLevels);
  await effort("Low").click();
  await chat.closed();
  await chat.named("Select model, currently Opus 5.5, thinking Low");
  await chat.open();
  await gateway.hover();
  await chat.page.getByRole("tooltip", { name: "CLIProxyAPI", exact: true }).waitFor();
  assert.equal(await tab(rail, "Your subscriptions").getAttribute("aria-selected"), "true");
  await escape();
  await chat.page.close();

  for (const parameters of ["", "&gateway"]) {
    chat = await visit("model=claude-code:opus&level=high" + parameters, phone, true);
    await chat.open();
    await checkFocus(chat.menu);
    const [bounds, agent, modelBox, thinkBox] = await Promise.all(
      [chat.menu, agents(), row("Opus 5.5"), effort("High")].map((el) => el.boundingBox())
    );
    assert(
      bounds.x >= 8 &&
        bounds.x + bounds.width <= 382 &&
        bounds.y >= 8 &&
        bounds.y + bounds.height <= 712
    );
    assert(agent.y + agent.height <= modelBox.y && modelBox.x + modelBox.width <= thinkBox.x);
    if (parameters) {
      const sources = await rail().boundingBox();
      assert(sources.x + sources.width <= agent.x);
    }
    await search().tap();
    await checkFocus(search());
    await chat.page.close();
  }

  const current = "gateway:codex-app-server:revision:work:one";
  chat = await visit("gateway&started&level=medium&model=" + current, phone);
  assert.equal((await chat.trigger.innerText()).replace(/\s+/g, " "), "GPT 6.2 Astra Medium");
  await chat.trigger.hover();
  await chat.page.getByRole("tooltip", { name: "CLIProxyAPI · Codex", exact: true }).waitFor();
  await chat.open();
  assert.equal(await tab(rail, "CLIProxyAPI").getAttribute("aria-selected"), "true");
  assert.equal(await tab(agents, "Codex").getAttribute("aria-selected"), "true");
  assert.equal(await effort("Medium").getAttribute("aria-checked"), "true");
  assert.equal(await row("GPT 6.2 Astra").locator("svg").count(), 1);
  assert.equal(await row("GPT Terra").locator("svg").count(), 0);
  assert.equal(await row("Hidden image").count(), 0);
  await tab(agents, "Claude Code").click();
  await row("Claude Sonnet").hover();
  assert.deepEqual(await chat.menu.getByRole("radio").allTextContents(), ["Medium", "High"]);
  await row("Claude Sonnet").click();
  await chat.closed();
  assert.equal(await state("opened"), "gateway:claude-code:revision:claude-a");
  assert.equal(await state("opened-level"), "high");
  assert.equal(await state("model"), current);
  assert.equal(await state("level"), "medium");
  await chat.open();
  assert.equal(await tab(agents, "Codex").getAttribute("aria-selected"), "true");
  await tab(rail, "Your subscriptions").click();
  await row("GPT-6-Astra").click();
  await chat.closed();
  assert.equal(await state("opened"), "codex-app-server:gpt-6-astra");
  await chat.open();
  await row("GPT Terra").click();
  await chat.closed();
  await chat.named("Select model, currently GPT Terra");
  assert.equal(await state("level"), "off");
  assert.deepEqual(await pickArgs(), ["gateway:codex-app-server:revision:same-family", "off"]);
  await chat.open();
  await chat.menu.getByText("GPT Terra has no thinking control.", { exact: true }).waitFor();
  assert.equal(await chat.menu.getByRole("radio").count(), 0);
  await chat.page.close();

  chat = await visit(
    "model=gateway:codex-app-server:former:work:one&level=high&gateway&started&codexOnly"
  );
  await chat.open();
  assert.equal(await agents().count(), 0);
  await chat.menu.getByLabel("Agent", { exact: true }).getByText("Codex").waitFor();
  assert.deepEqual(await chat.menu.getByText(/^work:one /).allTextContents(), [
    "work:one is no longer available.",
  ]);
  await row("GPT 6.2 Astra").click();
  await chat.closed();
  assert.equal(await state("opened"), current);
  assert.equal(await state("opened-level"), "medium");
  assert.match(await state("model"), /:former:/);
  await chat.page.close();

  chat = await visit("model=claude-code:opus&level=high&gateway&empty");
  await chat.open();
  await tab(rail, "CLIProxyAPI").click();
  await chat.menu.getByText("No chat models available.", { exact: true }).waitFor();
  assert.equal(await agents().count(), 0);
  await search().fill("anything");
  await search().press("ArrowDown");
  await checkActive("Open AI Providers");
  await checkFocus(search());
  await key("Enter");
  await chat.closed();
  assert(
    await chat.page.evaluate(
      () => window.uiState().settingsOpen && window.uiState().activeSettingsSection === "ai"
    )
  );
  await chat.open();
  await tab(rail, "CLIProxyAPI").click();
  await tab(rail, "Your subscriptions").click();
  await row("Opus 5.5").waitFor();
  await chat.page.close();

  for (const browsing of ["gateway", "subscriptions", "rail", "subscription rail"]) {
    chat = await visit("gateway&started&level=high&model=" + current);
    await chat.open();
    if (browsing.startsWith("subscription")) await tab(rail, "Your subscriptions").click();
    if (browsing.endsWith("rail")) await rail().getByRole("tab", { selected: true }).focus();
    else await search().fill("no such model");
    await chat.page.evaluate(() => globalThis.dispatchEvent(new Event("disconnect-gateway")));
    await rail().waitFor({ state: "detached" });
    assert.equal(await search().inputValue(), browsing === "subscriptions" ? "no such model" : "");
    await search().fill("GPT-6-Astra");
    await key("Enter");
    await chat.closed();
    assert.equal(await state("opened"), "codex-app-server:gpt-6-astra");
    assert.equal(await state("model"), current);
    await chat.page.close();
  }

  chat = await visit("model=claude-code:opus&level=high&gateway");
  await chat.open();
  await tab(rail, "CLIProxyAPI").click();
  await tab(agents, "Codex").click();
  await search().fill("work:one");
  await key("Enter");
  await chat.closed();
  await chat.named("Select model, currently GPT 6.2 Astra, thinking High");
  assert.deepEqual(await pickArgs(), [current, "high"]);
  assert.equal(await state("model"), current);
  await chat.page.close();

  for (const variant of ["", "&samePreset"]) {
    chat = await visit("gateway&two&started&level=high&model=" + current + variant);
    await chat.open();
    const names = await rail()
      .getByRole("tab")
      .evaluateAll((tabs) => tabs.map((t) => t.getAttribute("aria-label")));
    assert.deepEqual(
      names,
      variant
        ? ["Your subscriptions", "CLIProxyAPI · localhost", "CLIProxyAPI · localhost:8318"]
        : ["Your subscriptions", "CLIProxyAPI", "OpenRouter"]
    );
    await tab(rail, names[2]).click();
    await row("GPT 6.2 Astra").click();
    await chat.closed();
    assert.equal(await state("opened"), "gateway:codex-app-server:other:work:one");
    assert.equal(await state("opened-level"), "medium");
    assert.equal(await state("model"), current);
    await chat.page.close();
  }
  chat = await visit("model=claude-code:opus&level=high&gateway&identity");
  await chat.open();
  await tab(rail, "CLIProxyAPI").click();
  await tab(agents, "Codex").click();
  const sameLabel = list()
    .getByRole("group", { name: "GitHub Copilot" })
    .getByRole("option", { name: "Shared" });
  for (const query of ["Shared", "cOpIlOt", "GitHub", "work:one"]) {
    await search().fill(query);
    assert.equal(await sameLabel.count(), 2);
  }
  const prefix = "gateway:codex-app-server:a986d995-65dd-450c-a136-dbafe4459326:";
  assert.deepEqual(await sameLabel.evaluateAll((rows) => rows.map((row) => row.dataset.value)), [
    prefix + "Work:One",
    prefix + "work:one:other",
  ]);
  await search().fill(":other");
  await sameLabel.waitFor();
  await checkActive("Shared");
  await checkGlide();
  await key("Enter");
  await chat.closed();
  assert.equal(await state("model"), prefix + "work:one:other");
  await chat.page.close();

  // Home fits its preferred native effort separately for each model.
  chat = await visit("homePreference");
  await chat.open();
  await effort("Max").click();
  await chat.closed();
  await chat.open();
  await tab(agents, "Codex").click();
  await row("GPT-5.5").click();
  await chat.closed();
  await chat.named("Select model, currently GPT-5.5, thinking Extra high");
  await chat.open();
  await tab(agents, "Claude Code").click();
  await row("Opus 5.5").click();
  await chat.closed();
  await chat.named("Select model, currently Opus 5.5, thinking Max");
  await chat.page.close();

  const settings = await browser.newPage();
  await settings.goto(base + "/?settings&two");
  const catalog = settings.getByRole("button", { name: /CLIProxyAPI.*5 models/ });
  const add = settings.getByRole("button", { name: "Add gateway" });
  const options = settings.getByRole("button", { name: "CLIProxyAPI options" });
  const menu = settings.getByRole("menu");
  const fill = settings
    .getByRole("region", { name: "Gateways" })
    .locator('[data-slot="glide"][data-lit]');
  async function paint(control) {
    return control.evaluate(async (el) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.allSettled(el.getAnimations().map((animation) => animation.finished));
      const css = getComputedStyle(el);
      return {
        visible: el.matches(":focus-visible"),
        shadow: css.boxShadow,
        duration: css.transitionDuration,
      };
    });
  }
  await add.waitFor();
  const idle = await paint(add);
  await add.click();
  await menu.waitFor();
  await add.click();
  await menu.waitFor({ state: "hidden" });
  assert.deepEqual(await paint(add), idle);
  await add.click();
  await menu.waitFor();
  await settings.getByRole("heading", { name: "Gateways" }).click();
  await menu.waitFor({ state: "hidden" });
  assert.deepEqual(await paint(add), idle);
  await settings.reload();
  await add.waitFor();
  await settings.keyboard.press("Tab");
  const keyboard = await paint(add);
  assert(keyboard.visible && keyboard.shadow !== idle.shadow);
  await add.press("Enter");
  await menu.getByRole("menuitem").first().and(settings.locator(":focus")).waitFor();
  await settings.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.deepEqual(await paint(add), keyboard);
  await settings.keyboard.press("Tab");
  await settings.keyboard.press("Tab");
  assert.deepEqual(await paint(options), keyboard);

  await catalog.hover();
  await fill.waitFor({ timeout: 3000 });
  const gatewayRow = catalog.locator("..");
  const [lit, header, frame, trailing] = await Promise.all(
    [fill, gatewayRow, gatewayRow.locator(".."), options].map((el) => el.boundingBox())
  );
  for (const side of ["x", "y", "width", "height"])
    assert(Math.abs(lit[side] - header[side]) <= 0.5);
  assert(trailing.x + trailing.width <= lit.x + lit.width);
  const radii = await Promise.all(
    [gatewayRow.locator(".."), fill].map((el) =>
      el.evaluate((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius))
    )
  );
  assert(header.x > frame.x);
  assert.equal(radii[1], radii[0] - (header.x - frame.x));
  await options.hover();
  assert.deepEqual(await fill.boundingBox(), lit);
  const bg = (control) => control.evaluate((el) => getComputedStyle(el).backgroundColor);
  await options.click();
  await menu.getByRole("menuitem", { name: "Edit connection" }).hover();
  await paint(options);
  const pressed = await bg(options);
  await settings.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await settings.getByText("Provider rules", { exact: true }).hover();
  await paint(options);
  assert.notEqual(pressed, await bg(options));
  await fill.waitFor({ state: "hidden" });
  await settings.getByRole("button", { name: "OpenRouter options" }).hover();
  await fill.waitFor();
  assert((await fill.boundingBox()).y > header.y);
  const rules = settings.getByText("Provider rules", { exact: true });
  await rules.waitFor();
  const terms = {
    Anthropic: "https://code.claude.com/docs/en/legal-and-compliance",
    OpenAI: "https://openai.com/policies/row-terms-of-use/",
    Google: "https://antigravity.google/docs/faq/",
  };
  for (const [name, url] of Object.entries(terms))
    assert.equal(await settings.getByRole("link", { name, exact: true }).getAttribute("href"), url);
  await settings.getByRole("button", { name: "Add gateway" }).click();
  assert.deepEqual(await settings.getByRole("menuitem").allTextContents(), [
    "OpenRouter",
    "CLIProxyAPI",
    "Custom",
  ]);
  await settings.getByRole("menuitem", { name: "CLIProxyAPI", exact: true }).click();
  const form = settings.getByRole("dialog");
  await form.getByRole("spinbutton", { name: "Local port" }).waitFor();
  assert.equal(await form.getByLabel("Base URL", { exact: true }).count(), 0);
  await form.getByText("Provider rules", { exact: true }).waitFor();
  await form
    .getByText(
      "Safest with API keys. If you sign a personal subscription into the proxy, or switch between accounts to get past a limit, the provider can suspend that account.",
      { exact: true }
    )
    .waitFor();
  async function closeGatewayForm() {
    await settings.locator('[data-slot="dropdown-menu-content"]').waitFor({ state: "detached" });
    await form.locator(":focus").waitFor();
    await settings.keyboard.press("Escape");
    await settings
      .getByRole("button", { name: "Add gateway" })
      .and(settings.locator(":focus"))
      .waitFor();
  }
  await closeGatewayForm();
  await settings.getByRole("button", { name: "Add gateway" }).click();
  await settings.getByRole("menuitem", { name: "OpenRouter", exact: true }).click();
  await form.getByText("https://openrouter.ai/api", { exact: true }).waitFor();
  assert.equal(await form.getByLabel("Base URL", { exact: true }).count(), 0);
  await closeGatewayForm();
  await settings.getByRole("button", { name: "Add gateway" }).click();
  await settings.getByRole("menuitem", { name: "Custom", exact: true }).click();
  const confirm = form.getByRole("button", { name: "Connect", exact: true });
  assert.equal(await confirm.isDisabled(), true);
  await form.getByRole("switch", { name: /OpenAI Responses/ }).click();
  assert.equal(await confirm.isEnabled(), true);
  assert.equal(await form.getByText("Provider rules", { exact: true }).count(), 0);
  await closeGatewayForm();
  await options.click();
  await settings.getByRole("menuitem", { name: "Edit connection" }).click();
  await form.getByRole("button", { name: "Save connection" }).waitFor();
  await form.getByRole("button", { name: "Close" }).click();
  await options.and(settings.locator(":focus")).waitFor({ timeout: 3000 });
  await catalog.click();
  assert.equal(await settings.evaluate(() => window.catalogReads ?? 0), 0);
  await settings.getByRole("heading", { name: "OpenAI", exact: true }).waitFor();
  const rows = settings.getByRole("listitem");
  await rows.filter({ hasText: "work:one" }).getByText("Codex", { exact: true }).waitFor();
  await rows
    .filter({ hasText: "Claude Sonnet" })
    .getByText("Claude Code", { exact: true })
    .waitFor();
  await rows
    .filter({ hasText: "Hidden image" })
    .getByText("Not offered in chat", { exact: true })
    .waitFor();
  assert.equal(await rows.count(), 5);
  await options.click();
  await settings.getByRole("menuitem", { name: "Refresh models" }).click();
  assert.equal(await settings.evaluate(() => window.catalogReads), 1);
  await settings.close();

  chat = await visit("gateway&many&model=gateway:codex-app-server:extra-15:work:one&level=medium");
  await chat.open();
  const selectedSource = rail().locator('[aria-selected="true"]');
  assert.equal(await rail().getByRole("tab").count(), 18);
  assert(
    await selectedSource.evaluate((node) => {
      const rail = node.closest('[role="tablist"]');
      const bounds = rail.getBoundingClientRect();
      const selected = node.getBoundingClientRect();
      return rail.scrollTop > 0 && selected.top >= bounds.top && selected.bottom <= bounds.bottom;
    })
  );
  await chat.page.close();

  assert.deepEqual(errors, []);
  console.log(`PASS: ${cases.length} picker scenarios and the Settings gateway checks`);
} finally {
  await browser?.close();
  await server.close();
}
