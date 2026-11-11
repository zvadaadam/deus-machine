/* global document */
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
import { ModelPicker } from "@/features/session/ui/ModelPicker";
import { CATALOG_MODEL_LISTS, fitThinkingLevel, modelThinkingLevels, parseModelValue } from "@shared/models";
import type { ThinkingLevel } from "@shared/protocol";
import "@/global.css";
const levelsOf = (value: string) => {
  const { harness, model } = parseModelValue(value)!;
  return modelThinkingLevels(CATALOG_MODEL_LISTS, harness, model);
};
function App() {
  const params = new URLSearchParams(location.search);
  const [model, setModel] = useState(params.get("model")!);
  const [level, setLevel] = useState(params.get("level") as ThinkingLevel);
  const [opened, setOpened] = useState("");
  const levels = levelsOf(model);
  return <main className="bg-background text-foreground flex min-h-screen flex-col justify-end p-4">
    <output data-model={model} data-level={level} data-opened={opened} />
    <ModelPicker model={model} lists={CATALOG_MODEL_LISTS}
      thinkingLevel={fitThinkingLevel(level, levels, "high")} thinkingLevels={levels}
      hasMessages={params.has("started")}
      onModelChange={(value) => { setModel(value); setLevel((current) => fitThinkingLevel(current, levelsOf(value), "high")); }}
      onThinkingLevelChange={setLevel} onOpenNewTab={(value) => setOpened(value ?? "")} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
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
    const menu = page.getByRole("menu");
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
      ...["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5", "Sonnet 5", "Opus 5", "Fable 5"],
      ...["Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6"],
    ]
  );
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
  for (const next of ["Codex", "Opus 5.5", "Fable 5.1"]) {
    await chat.page.keyboard.press("ArrowDown");
    await focused(next);
  }
  await chat.page.keyboard.press("Enter");
  await chat.closed();
  await chat.named("Select model, currently Fable 5.1, thinking High");
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

  assert.deepEqual(errors, []);
  console.log(
    "PASS: one picker for agent, model and thinking: trigger phrase, level marks on the right, level fitted on a model change, no control for Haiku, keyboard, a started chat's other agent, phone width"
  );
} finally {
  await browser?.close();
  await server.close();
}
