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
import { ModelPicker } from "@/features/session/ui/ModelPicker";
import { gatewayThinking } from "@shared/gateways";
import { CATALOG_MODEL_LISTS, fitThinkingLevel, modelThinkingLevels, parseModelValue } from "@shared/models";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GatewaysSection } from "@/features/settings/ui/sections/GatewaysSection";
import type { ThinkingLevel } from "@shared/protocol";
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
if (params.has("settings")) client.setQueryData(["gateways"], [gateway,...(params.has("two")?[{...gateway,ref:"router",preset:"openrouter",revision:"router",baseUrl:"https://openrouter.ai/api"}]:[])]);
function App() {
  if(params.has("settings")) return <QueryClientProvider client={client}><GatewaysSection local={true} checking={false} recheck={async()=>{window.catalogReads=(window.catalogReads??0)+1;}}/></QueryClientProvider>;
  const [model, setModel] = useState(params.get("model")!);
  const [level, setLevel] = useState(params.get("level") as ThinkingLevel);
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
  const extra = params.has("many") ? Array.from({length:16},(_,i)=>({...gateway,preset:"custom",ref:"extra-"+i,revision:"extra-"+i,baseUrl:"https://gateway-"+i+".example",models:offered})):[];
  return <main className="bg-background text-foreground flex min-h-screen flex-col justify-end p-4">
    <output data-model={model} data-level={level} data-opened={opened} data-opened-level={openedLevel} />
    <ModelPicker model={model} agentHarness={parseModelValue(model)!.harness} lists={CATALOG_MODEL_LISTS} gateways={connected?[{...gateway,models:offered},...extra,...(params.has("two")?[{...gateway,ref:"router",revision:"other",preset:"openrouter",models:offered}]:[])]:[]}
      thinkingLevel={fitThinkingLevel(level, levels, "high")}
      previousGateway={params.has("started") && parseModelValue(model)?.gatewayRevision ? {ref:gateway.ref,label:"CLIProxyAPI"} : undefined}
      hasMessages={params.has("started")}
      onModelChange={({value}, effort) => { setModel(value); setLevel((current) => effort ?? fitThinkingLevel(current, levelsOf(value), "high")); }}
      onThinkingLevelChange={setLevel} onOpenNewTab={(value, level) => { setOpened(value ?? ""); setOpenedLevel(level ?? ""); }} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<TooltipProvider><App /></TooltipProvider>);
`
);
const server = await createServer({
  configFile: false,
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
            '<!doctype html><html><body><main id="root"></main><script type="module" src="/.context/model-picker-ui/entry.tsx"></script></body></html>'
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
  const visit = async (query, viewport = { width: 760, height: 620 }) => {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    await page.goto(`${base}/?${query}`);
    const trigger = page.getByRole("button", { name: /^Select model, currently/ });
    await trigger.waitFor();
    const menu = new URLSearchParams(query).has("gateway")
      ? page.getByRole("dialog", { name: "Model and thinking effort" })
      : page.getByRole("menu");
    return {
      page,
      trigger,
      menu,
      state: page.locator("output"),
      open: async () => {
        await trigger.click();
        await menu.waitFor();
        // Measurements wait for the menu to finish arriving.
        await menu.evaluate((node) => Promise.all(node.getAnimations().map((a) => a.finished)));
      },
      closed: () => menu.waitFor({ state: "detached" }),
      named: (name) => trigger.and(page.getByRole("button", { name, exact: true })).waitFor(),
    };
  };

  // The trigger reads as one phrase: the model, then how hard it thinks.
  let chat = await visit("model=claude-code:opus&level=xhigh");
  await chat.named("Select model, currently Opus 5.5, thinking Extra high");
  assert.equal((await chat.trigger.innerText()).replace(/\s+/g, " "), "Opus 5.5 Extra high");

  // One menu: the agents, the shown agent's models, the model's thinking levels.
  await chat.open();
  assert.deepEqual(
    await chat.menu.getByRole("menuitem").evaluateAll((items) => items.map((i) => i.textContent)),
    [
      "Claude Code",
      "Codex",
      "Gemini",
      ...["Opus 5.5", "Fable 5.2", "Sonnet 5.5", "Haiku 5.5", "Fable 5.1", "Haiku 4.5", "Sonnet 5"],
      ...["Opus 5", "Fable 5"],
      ...["Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6"],
    ]
  );
  assert.equal(await chat.menu.getByRole("searchbox").count(), 0);
  assert.equal(await chat.menu.getByRole("tablist").count(), 0);
  assert.equal((await chat.menu.boundingBox()).width, 384);
  const levels = chat.menu.getByRole("menuitemradio");
  assert.deepEqual(await levels.evaluateAll((items) => items.map((i) => i.textContent)), [
    "Low",
    "Medium",
    "High",
    "Extra high",
    "Max",
  ]);
  assert.deepEqual(
    await levels.evaluateAll((items) => items.map((i) => i.getAttribute("aria-checked"))),
    ["false", "false", "false", "true", "false"]
  );
  // A level's name starts where the "Thinking" title does: the mark is on the right.
  const left = (locator) =>
    locator.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().left;
    });
  const offset =
    (await left(chat.menu.getByText("Low", { exact: true }))) -
    (await left(chat.menu.getByText("Thinking", { exact: true })));
  assert(Math.abs(offset) < 1, `level names sit ${offset}px off their title`);

  // Choosing a level closes the menu and the trigger says it.
  await levels.filter({ hasText: "Max" }).click();
  await chat.closed();
  await chat.named("Select model, currently Opus 5.5, thinking Max");

  // Looking at another agent chooses nothing; its model changes agent and model
  // together, and the level becomes the nearest one that model offers.
  await chat.open();
  await chat.menu.getByRole("menuitem", { name: "Codex", exact: true }).click();
  await chat.menu.getByRole("menuitem", { name: "GPT-6.1-Sol", exact: true }).waitFor();
  assert.equal(await chat.state.getAttribute("data-model"), "claude-code:opus");
  await chat.menu.getByRole("menuitem", { name: "GPT-5.5", exact: true }).click();
  await chat.closed();
  await chat.named("Select model, currently GPT-5.5, thinking Extra high");
  assert.equal(await chat.state.getAttribute("data-model"), "codex-app-server:gpt-5.5");

  // A model with no thinking control: the trigger is the model alone.
  await chat.open();
  await chat.menu.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
  await chat.menu.getByRole("menuitem", { name: "Haiku 4.5", exact: true }).click();
  await chat.closed();
  await chat.named("Select model, currently Haiku 4.5");
  await chat.open();
  await chat.menu.getByText("Haiku 4.5 has no thinking control.", { exact: true }).waitFor();
  assert.equal(await chat.menu.getByRole("menuitemradio").count(), 0);
  await chat.page.keyboard.press("Escape");
  await chat.closed();

  // Keyboard: Enter opens on the first item, arrows walk agents then models, Enter chooses.
  await chat.trigger.focus();
  await chat.page.keyboard.press("Enter");
  await chat.menu.waitFor();
  const focused = (text) =>
    chat.page.waitForFunction((want) => document.activeElement?.textContent === want, text);
  await focused("Claude Code");
  for (const next of ["Codex", "Gemini", "Opus 5.5", "Fable 5.2", "Sonnet 5.5"]) {
    await chat.page.keyboard.press("ArrowDown");
    await focused(next);
  }
  await chat.page.keyboard.press("Enter");
  await chat.closed();
  await chat.named("Select model, currently Sonnet 5.5, thinking High");
  await chat.page.close();

  // A started chat keeps its agent: another agent's model opens a new chat.
  chat = await visit("model=claude-code:sonnet&level=high&started");
  await chat.open();
  await chat.menu.getByRole("menuitem", { name: "Codex", exact: true }).click();
  await chat.menu.getByText("Opens a new chat", { exact: true }).waitFor();
  await chat.menu.getByRole("menuitem", { name: "GPT-6-Astra", exact: true }).click();
  await chat.closed();
  assert.equal(await chat.state.getAttribute("data-model"), "claude-code:sonnet");
  assert.equal(await chat.state.getAttribute("data-opened"), "codex-app-server:gpt-6-astra");
  await chat.page.close();

  // A phone's width: the whole menu is on screen, clear of both edges.
  chat = await visit("model=claude-code:fable&level=high", { width: 390, height: 700 });
  await chat.open();
  const box = await chat.menu.boundingBox();
  assert(box.x >= 8 && box.x + box.width <= 382, `menu leaves the screen: ${JSON.stringify(box)}`);
  assert(box.y >= 8, `menu leaves the screen: ${JSON.stringify(box)}`);
  await chat.page.close();

  const rail = () => chat.menu.getByRole("tablist", { name: "Account sources" });
  const agents = () => chat.menu.getByRole("tablist", { name: "Agents" });
  const tab = (group, name) => group().getByRole("tab", { name, exact: true });
  const row = (name) => chat.menu.getByRole("menuitem", { name, exact: true });
  const effort = (name) => chat.menu.getByRole("menuitemradio", { name, exact: true });
  const search = () => chat.menu.getByRole("searchbox", { name: "Search models" });
  const checkFocus = (locator) => locator.and(chat.page.locator(":focus")).waitFor();
  const key = (name) => chat.page.keyboard.press(name);
  const tabNames = (group) => group().getByRole("tab").allTextContents();
  chat = await visit("model=claude-code:opus&level=high&gateway&mixed");
  await chat.trigger.focus();
  await key("Enter");
  const personal = tab(rail, "Your subscriptions");
  const gateway = tab(rail, "CLIProxyAPI");
  await checkFocus(personal);
  assert.deepEqual(await tabNames(rail), ["", ""]);
  assert.deepEqual(await tabNames(agents), ["Claude Code", "Codex", "Gemini"]);
  assert.equal(await rail().getByRole("separator").count(), 1);
  for (const stop of [
    tab(agents, "Claude Code"),
    search(),
    row("Opus 5.5"),
    effort("High"),
    personal,
  ]) {
    await key("Tab");
    await checkFocus(stop);
  }
  await key("Shift+Tab");
  await checkFocus(effort("High"));
  await key("Tab");
  await checkFocus(personal);
  await gateway.hover();
  await chat.page.getByRole("tooltip", { name: "CLIProxyAPI", exact: true }).waitFor();
  assert.equal(await personal.getAttribute("aria-selected"), "true");
  await personal.focus();
  await key("ArrowDown");
  await checkFocus(gateway);
  assert.equal(await gateway.getAttribute("aria-selected"), "true");
  assert.deepEqual(await tabNames(agents), ["Claude Code", "Codex"]);
  await key("ArrowRight");
  await checkFocus(tab(agents, "Claude Code"));
  await chat.menu.getByRole("heading", { name: "Anthropic" }).waitFor();
  await chat.menu.getByRole("heading", { name: "Kimi" }).waitFor();
  assert.equal(await row("GPT 6.2 Astra").count(), 0);
  await key("ArrowRight");
  await checkFocus(tab(agents, "Codex"));
  assert.equal(await row("Claude Sonnet").count(), 0);
  assert.equal(await chat.menu.getByRole("heading", { name: "OpenAI" }).count(), 0);
  assert.equal(await chat.menu.getByText(/^via /).count(), 0);
  await key("ArrowDown");
  await checkFocus(search());
  for (const q of ["Astra", "work:one", "OpenAI"]) {
    await search().fill(q);
    await row("GPT 6.2 Astra").waitFor();
  }
  await search().fill("absent");
  await chat.menu.getByText("No matching models.", { exact: true }).waitFor();
  assert.deepEqual(await tabNames(agents), ["Claude Code", "Codex"]);
  await search().fill("work:one");
  await search().evaluate((el) => el.setSelectionRange(1, 1));
  await key("ArrowRight");
  await checkFocus(search());
  await key("End");
  await key("ArrowDown");
  await checkFocus(row("GPT 6.2 Astra"));
  await key("ArrowRight");
  await checkFocus(effort("High"));
  await key("ArrowUp");
  await checkFocus(effort("Medium"));
  await key("ArrowLeft");
  await checkFocus(row("GPT 6.2 Astra"));
  await key("ArrowUp");
  await checkFocus(search());
  await key("ArrowUp");
  await checkFocus(tab(agents, "Codex"));
  await key("ArrowUp");
  await checkFocus(gateway);
  await key("ArrowUp");
  await checkFocus(personal);
  assert.equal(await tab(agents, "Codex").getAttribute("aria-selected"), "true");
  assert.equal(await search().inputValue(), "");
  await tab(agents, "Claude Code").click();
  await row("Haiku 4.5").hover();
  await chat.menu.getByText("Haiku 4.5 has no thinking control.").waitFor();
  await row("Sonnet 5.5").hover();
  await effort("Low").click();
  await chat.named("Select model, currently Sonnet 5.5, thinking Low");
  await chat.page.close();

  chat = await visit(
    "model=gateway:codex-app-server:revision:work:one&level=medium&gateway&started",
    { width: 390, height: 720 }
  );
  assert.equal((await chat.trigger.innerText()).replace(/\s+/g, " "), "GPT 6.2 Astra Medium");
  await chat.trigger.hover();
  await chat.page.getByRole("tooltip", { name: "CLIProxyAPI · Codex", exact: true }).waitFor();
  await chat.open();
  assert.equal(await tab(rail, "CLIProxyAPI").getAttribute("aria-selected"), "true");
  assert.equal(await tab(agents, "Codex").getAttribute("aria-selected"), "true");
  await chat.page.mouse.move(375, 25);
  await chat.page.getByRole("tooltip").waitFor({ state: "hidden" });
  assert.equal(await effort("Medium").getAttribute("aria-checked"), "true");
  assert.equal(await row("GPT 6.2 Astra").locator("svg").count(), 1);
  assert.equal(await row("GPT Terra").locator("svg").count(), 0);
  assert.equal(await chat.menu.getByText("hidden-image").count(), 0);
  const [bounds, src, agentBox, modelBox, thinkBox] = await Promise.all(
    [chat.menu, rail(), agents(), row("GPT 6.2 Astra"), effort("Medium")].map((el) =>
      el.boundingBox()
    )
  );
  assert(bounds.x >= 8 && bounds.x + bounds.width <= 382);
  assert(src.x + src.width <= agentBox.x && agentBox.y + agentBox.height <= modelBox.y);
  assert(modelBox.x + modelBox.width <= thinkBox.x);
  await tab(agents, "Claude Code").click();
  await chat.menu.getByText("Open in new chat", { exact: true }).waitFor();
  await row("Claude Sonnet").hover();
  await effort("Low").click();
  await chat.closed();
  assert.equal(
    await chat.state.getAttribute("data-opened"),
    "gateway:claude-code:revision:claude-a"
  );
  assert.equal(await chat.state.getAttribute("data-opened-level"), "low");
  assert.equal(
    await chat.state.getAttribute("data-model"),
    "gateway:codex-app-server:revision:work:one"
  );
  assert.equal(await chat.state.getAttribute("data-level"), "medium");
  await chat.open();
  assert.equal(await tab(agents, "Codex").getAttribute("aria-selected"), "true");
  await tab(rail, "Your subscriptions").click();
  await chat.menu.getByText("Open in new chat", { exact: true }).waitFor();
  await row("GPT-6-Astra").click();
  await chat.closed();
  assert.equal(await chat.state.getAttribute("data-opened"), "codex-app-server:gpt-6-astra");
  await chat.open();
  await row("GPT Terra").hover();
  assert.equal(await chat.menu.getByRole("menuitemradio").count(), 0);
  await row("GPT Terra").click();
  await chat.closed();
  assert.equal((await chat.trigger.innerText()).trim(), "GPT Terra");
  await chat.page.close();

  chat = await visit(
    "model=gateway:codex-app-server:former:work:one&level=medium&gateway&started&codexOnly"
  );
  await chat.open();
  assert.equal(await agents().count(), 0);
  await chat.menu.getByLabel("Agent", { exact: true }).getByText("Codex").waitFor();
  await chat.menu.getByText("Open in new chat", { exact: true }).click();
  await chat.closed();
  assert.equal(
    await chat.state.getAttribute("data-opened"),
    "gateway:codex-app-server:revision:work:one"
  );
  assert.equal(await chat.state.getAttribute("data-opened-level"), "medium");
  await chat.page.close();

  chat = await visit("model=claude-code:opus&level=high&gateway&empty");
  await chat.open();
  await tab(rail, "CLIProxyAPI").click();
  await chat.menu.getByText("No chat models available.").waitFor();
  await search().focus();
  await key("ArrowDown");
  await checkFocus(chat.menu.getByRole("menuitem", { name: "Open AI Providers" }));
  await search().press("Enter");
  await chat.closed();
  await chat.open();
  await tab(rail, "CLIProxyAPI").click();
  assert.equal(await agents().getByRole("tab").count(), 0);
  await tab(rail, "Your subscriptions").click();
  await row("Opus 5.5").waitFor();
  await chat.page.close();

  chat = await visit("model=gateway:codex-app-server:revision:work:one&level=high&gateway&started");
  await chat.open();
  await search().fill("no such model");
  await chat.page.evaluate(() => globalThis.dispatchEvent(new Event("disconnect-gateway")));
  const remaining = chat.page.getByRole("menu");
  await remaining.getByRole("menuitem", { name: "GPT-6-Astra", exact: true }).waitFor();
  assert.equal(await remaining.getByRole("searchbox").count(), 0);
  assert.equal(await remaining.getByRole("tablist").count(), 0);
  await remaining.getByText("Open in new chat", { exact: true }).waitFor();
  await remaining.getByRole("menuitem", { name: "GPT-6-Astra", exact: true }).click();
  assert.equal(await chat.state.getAttribute("data-opened"), "codex-app-server:gpt-6-astra");
  assert.equal(
    await chat.state.getAttribute("data-model"),
    "gateway:codex-app-server:revision:work:one"
  );
  await chat.page.close();

  chat = await visit("model=claude-code:opus&level=high&gateway");
  await chat.open();
  await tab(rail, "CLIProxyAPI").click();
  await tab(agents, "Codex").click();
  await search().fill("work:one");
  await key("Enter");
  await chat.closed();
  await chat.named("Select model, currently GPT 6.2 Astra, thinking High");
  await chat.page.close();

  chat = await visit(
    "model=gateway:codex-app-server:revision:work:one&level=high&gateway&two&started"
  );
  await chat.open();
  assert.deepEqual(
    await rail()
      .getByRole("tab")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label"))),
    ["Your subscriptions", "CLIProxyAPI", "OpenRouter"]
  );
  await tab(rail, "OpenRouter").click();
  await chat.menu.getByText("Open in new chat", { exact: true }).click();
  await chat.closed();
  assert.match(await chat.state.getAttribute("data-opened"), /:other:work:one$/);
  assert.match(await chat.state.getAttribute("data-model"), /:revision:work:one$/);
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
  console.log(
    "PASS: native picker, account sources and agent tabs, model preview and effort, new-chat routing, keyboard, phone layout and catalog disclosure"
  );
} finally {
  await browser?.close();
  await server.close();
}
