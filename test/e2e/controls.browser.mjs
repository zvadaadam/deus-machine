/* global document, getComputedStyle, innerWidth, requestAnimationFrame, CSSTransition */
// Exercise the real control primitives with mouse, keyboard and touch layouts.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../..");
const artifacts = path.join(root, ".context/controls-ui");
await mkdir(artifacts, { recursive: true });
await writeFile(
  path.join(artifacts, "entry.tsx"),
  `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Plus, ChevronDown, Link2, MessagesSquare } from "lucide-react";
import "@/global.css";
function TabSet({id}) {
 return <Tabs defaultValue="one" data-testid={id}><TabsList className="h-9"><TabsTrigger value="one">First</TabsTrigger><TabsTrigger value="two">Second</TabsTrigger></TabsList><TabsContent value="one">First content</TabsContent><TabsContent value="two">Second content</TabsContent></Tabs>;
}
function App() {
 const [count,setCount]=useState(0),[first,setFirst]=useState(true);
 return <main className="bg-background text-foreground min-h-screen p-6 space-y-6">
 <h1 className="text-xl font-medium">Buttons and controls</h1>
 <p className="text-sm text-muted-foreground">Shared shapes, quiet hover, visible keyboard focus.</p>
 <section data-testid="reference-controls" className="bg-bg-elevated flex flex-wrap items-center gap-3 rounded-xl p-6 w-fit">
 <Button variant="outline" size="xs">View plans</Button>
 <Button variant="secondary" size="xs"><Link2 className="size-3.5"/>Copy link</Button>
 <Button size="xs"><MessagesSquare className="size-3.5"/>Try now</Button>
 <Button size="xs">Add<ChevronDown className="size-3.5"/></Button>
 </section>
 <section className="flex flex-wrap gap-3" aria-label="Button variants">{["default","secondary","outline","ghost","destructive","link"].map(variant=><Button key={variant} variant={variant} onClick={()=>setCount(n=>n+1)}>{variant}</Button>)}<Button disabled onClick={()=>setCount(n=>n+1)}>Disabled</Button></section>
 <section className="flex flex-wrap items-center gap-3" aria-label="Button sizes">{["xs","sm","default","lg"].map(size=><Button variant="outline" size={size} key={size}>{size} action</Button>)}<Button size="icon-xs" variant="ghost" aria-label="Add"><Plus /></Button><Button className="rounded-full" size="icon" aria-label="Circular action"><Plus /></Button></section>
 <section className="flex flex-wrap items-center gap-3">
 <ButtonGroup><Button size="xs">Create PR</Button><DropdownMenu><DropdownMenuTrigger asChild><Button variant="secondary" size="xs">main<ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={()=>setCount(n=>n+1)}>Choose branch</DropdownMenuItem></DropdownMenuContent></DropdownMenu></ButtonGroup>
 <Select defaultValue="local"><SelectTrigger aria-label="Environment"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local">Local</SelectItem><SelectItem value="cloud">Cloud</SelectItem></SelectContent></Select>
 <Button variant="outline" asChild><a href="#target">Link action</a></Button>
 </section>
 <p aria-live="polite">Actions: {count}</p>
 <Button variant="ghost" onClick={()=>setFirst(v=>!v)}>Toggle first tab set</Button>
 {first&&<TabSet id="first-tabs"/>}<TabSet id="second-tabs"/>
 </main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
`
);
const server = await createServer({
  configFile: false,
  root,
  cacheDir: path.join(artifacts, "vite-cache"),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  optimizeDeps: { entries: [path.join(artifacts, "entry.tsx")] },
  resolve: { alias: { "@": path.join(root, "apps/web/src") } },
  plugins: [
    tailwindcss(),
    {
      name: "control-fixture",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/.context/controls-ui/entry.tsx"></script></body></html>'
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
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 780 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  const primary = page.getByRole("button", { name: "default", exact: true });
  await primary.waitFor();
  assert(
    await page.getByRole("button", { name: "Circular action" }).evaluate((el) => {
      const style = getComputedStyle(el);
      return (
        parseFloat(style.borderTopLeftRadius) >= el.clientWidth / 2 &&
        !style.getPropertyValue("corner-shape").includes("superellipse")
      );
    }),
    "Circular controls override the shared shape without retaining its squircle"
  );
  const before = await primary.boundingBox();
  await primary.hover();
  await page.mouse.down();
  assert.deepEqual(
    await primary.boundingBox(),
    before,
    "Pressing does not move the control or scale its label"
  );
  await page.mouse.up();
  assert.equal(await page.getByText("Actions: 1", { exact: true }).count(), 1);
  const disabled = page.getByRole("button", { name: "Disabled", exact: true });
  assert(await disabled.isDisabled());
  await disabled.dispatchEvent("click");
  assert.equal(await page.getByText("Actions: 1", { exact: true }).count(), 1);
  await primary.focus();
  await page.keyboard.press("Tab");
  assert(
    await page
      .getByRole("button", { name: "secondary", exact: true })
      .evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).boxShadow !== "none")
  );
  await page.getByRole("button", { name: "main", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("menuitem", { name: "Choose branch" }).waitFor();
  await page.keyboard.press("Escape");
  assert(
    await page
      .getByRole("button", { name: "main", exact: true })
      .evaluate((el) => el === document.activeElement)
  );
  await page.getByRole("combobox", { name: "Environment" }).click();
  await page.getByRole("option", { name: "Cloud", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "Environment" }).textContent(), "Cloud");
  await page.getByRole("link", { name: "Link action" }).click();
  assert(page.url().endsWith("#target"), "Button asChild preserves link behavior");
  const survivingTab = page.getByTestId("second-tabs").getByRole("tab", { name: "First" });
  const indicator = () =>
    survivingTab.evaluate((el) => getComputedStyle(el, "::after").backgroundColor);
  const color = await indicator();
  assert.notEqual(color, "rgba(0, 0, 0, 0)");
  await page.getByRole("button", { name: "Toggle first tab set" }).click();
  assert.equal(
    await indicator(),
    color,
    "Unmounting another tab set preserves this active indicator"
  );
  await survivingTab.focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByTestId("second-tabs")
    .locator('[role="tab"][aria-selected="true"]')
    .filter({ hasText: "Second" })
    .waitFor();
  assert.equal(
    await page
      .getByTestId("second-tabs")
      .getByRole("tab", { name: "Second" })
      .getAttribute("aria-selected"),
    "true"
  );
  for (const theme of ["light", "dark"]) {
    await page.evaluate(async (t) => {
      document.documentElement.classList.toggle("dark", t === "dark");
      await new Promise(requestAnimationFrame);
      await Promise.all(
        document
          .getAnimations()
          .filter((a) => a instanceof CSSTransition)
          .map((a) => a.finished)
      );
    }, theme);
    await page.screenshot({ path: path.join(artifacts, `${theme}.png`) });
    await page
      .getByTestId("reference-controls")
      .screenshot({ path: path.join(artifacts, `reference-${theme}.png`) });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert(
    await primary.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration) < 0.01)
  );
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await mobile.goto(url);
  await mobile.getByRole("button", { name: "default", exact: true }).tap();
  assert.equal(await mobile.getByText("Actions: 1", { exact: true }).count(), 1);
  assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mobile.screenshot({ path: path.join(artifacts, "mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: control press stability, disabled actions, keyboard focus and menus, select/link behavior, independent tab lifetimes, reduced motion and mobile touch"
  );
} finally {
  await browser?.close();
  await server.close();
}
