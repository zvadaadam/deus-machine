/* global document, getComputedStyle, innerWidth, requestAnimationFrame, CSSAnimation, CSSTransition, DOMMatrixReadOnly */
// Exercise the real control primitives with mouse, keyboard and touch layouts.
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
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
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Plus, ChevronDown, Link2, Loader2, MessagesSquare } from "lucide-react";
import "@/global.css";
function TabSet({id}) {
 return <Tabs defaultValue="one" data-testid={id}><TabsList className="h-9"><TabsTrigger value="one">First</TabsTrigger><TabsTrigger value="two">Second</TabsTrigger></TabsList><TabsContent value="one">First content</TabsContent><TabsContent value="two">Second content</TabsContent></Tabs>;
}
function App() {
 const [count,setCount]=useState(0),[first,setFirst]=useState(true);
 const [pick,setPick]=useState(""),[target,setTarget]=useState("Local");
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
 <ButtonGroup><Button size="xs">Create PR</Button><DropdownMenu><DropdownMenuTrigger asChild><Button variant="secondary" size="xs">main<ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={()=>setCount(n=>n+1)}>Choose branch</DropdownMenuItem><DropdownMenuItem>Rename branch</DropdownMenuItem><DropdownMenuItem onSelect={()=>setPick("Menu inspect")}>Inspect branch</DropdownMenuItem></DropdownMenuContent></DropdownMenu></ButtonGroup>
 <DropdownMenu><DropdownMenuTrigger asChild><Button variant="secondary">Target: {target}</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuRadioGroup value={target} onValueChange={setTarget}>{["Local","Cloud"].map(place=><DropdownMenuRadioItem key={place} value={place}>{place}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
 <Select defaultValue="local"><SelectTrigger aria-label="Environment"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local">Local</SelectItem><SelectItem value="cloud">Cloud</SelectItem></SelectContent></Select>
 <Button variant="outline" asChild><a href="#target">Link action</a></Button>
 <Dialog><DialogTrigger asChild><Button variant="secondary">Open dialog</Button></DialogTrigger><DialogContent><DialogTitle>Preferences</DialogTitle><DialogDescription>Account preferences</DialogDescription></DialogContent></Dialog>
 <Loader2 data-testid="spinner" className="size-4 animate-spin" />
 </section>
 <p aria-live="polite">Actions: {count}</p>
 <Button variant="ghost" onClick={()=>setFirst(v=>!v)}>Toggle first tab set</Button>
 {first&&<TabSet id="first-tabs"/>}<TabSet id="second-tabs"/>
 <Command label="Branch commands"><CommandInput placeholder="Branch command" /><CommandList>{["Choose branch","Rename branch","Inspect branch"].map(label=><CommandItem key={label} onSelect={()=>setPick("Command "+label)}>{label}</CommandItem>)}</CommandList></Command>
 <output data-testid="picked">{pick}</output>
 </main>;
}

// Layout and copy feedback use their own page so the reference controls keep their layout.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { ContentTabBar } from "@/app/layouts/ContentTabBar";
import { CopyButton } from "@/features/session/ui/tools/components/CopyButton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { Sidebar, SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ResizeHandle } from "@/shared/components/ResizeHandle";
import { useResizeHandle } from "@/features/workspace/hooks/useResizeHandle";
import { SettingsSidebar } from "@/features/settings/ui/SettingsSidebar";
const client = new QueryClient();
client.setQueryData(queryKeys.settings.all, {});
function NoJumps() {
 const [tab, setTab] = useState("changes"), [pending, setPending] = useState(false);
 return <QueryClientProvider client={client}><TooltipProvider>
   <ContentTabBar activeTab={tab} onTabChange={setTab} visibility={{}} />
   <output data-testid="panel">{tab}</output>
   <Tabs defaultValue="Pull Requests"><TabsList aria-label="References">
     {["Pull Requests", "Branches", "Tags", "History"].map(label =>
       <TabsTrigger key={label} value={label}><Link2/>{label}</TabsTrigger>)}
   </TabsList></Tabs>
   <CopyButton text="Clipboard sample" />
   <button onClick={() => setPending(value => !value)}>Toggle pending</button>
   {pending && <Skeleton className="size-8" />}
 </TooltipProvider></QueryClientProvider>;
}
function DesktopSidebar() {
 const [open, setOpen] = useState(false), [width, setWidth] = useState<number | null>(null);
 const { handleProps, isDragging } = useResizeHandle({ enabled: open, mode: "primary", onSizeChange: setWidth });
 return <SidebarProvider open={open} onOpenChange={setOpen} data-resizing={isDragging || undefined} style={{ "--sidebar-width": (width ?? 344) + "px" } as React.CSSProperties}>
   <Sidebar variant="inset" />
   {open && <ResizeHandle label="Resize sidebar" handleProps={handleProps} isDragging={isDragging} />}
   <SidebarInset />
 </SidebarProvider>;
}
const fixtures: Record<string, React.ReactNode> = {
 "#no-jumps": <NoJumps/>,
 "#settings": <QueryClientProvider client={client}><SidebarProvider><SettingsSidebar/></SidebarProvider></QueryClientProvider>,
 "#desktop-edge": <DesktopSidebar/>,
};
if (location.hash === "#desktop-edge") document.documentElement.classList.add("electron");
createRoot(document.getElementById("root")!).render(fixtures[location.hash] ?? <App/>);
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
  server: { middlewareMode: true, hmr: false },
});
const http = createHttpServer(server.middlewares);
let browser;
try {
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${http.address().port}`;
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
  await page.getByRole("menuitem", { name: "Choose branch" }).waitFor({ state: "detached" });
  assert(
    await page
      .getByRole("button", { name: "main", exact: true })
      .evaluate((el) => el === document.activeElement)
  );
  async function assertFill(list, marker, shouldSnap = true) {
    await list.locator('[data-slot="glide"][data-lit]').waitFor();
    assert(
      await list.evaluate(
        async (el, { marker, shouldSnap }) => {
          const fill = el.querySelector('[data-slot="glide"]');
          const row = el.querySelector(marker);
          const snapped = !getComputedStyle(fill).transitionProperty.includes("transform");
          await Promise.allSettled(fill.getAnimations().map((animation) => animation.finished));
          return (
            (!shouldSnap || snapped) &&
            Number(getComputedStyle(fill).opacity) === 1 &&
            Math.abs(fill.getBoundingClientRect().top - row.getBoundingClientRect().top) < 1
          );
        },
        { marker, shouldSnap }
      ),
      "The fill paints the target and keyboard changes snap"
    );
  }
  // Radix and cmdk own the Enter target. Capture transitionrun so this assertion
  // still sees the pointer travel when the entire 80 ms elapses between test calls.
  for (const [slot, itemRole, marker, expected] of [
    ["dropdown-menu-content", "menuitem", "[data-highlighted]", "Menu inspect"],
    ["command-list", "option", "[data-selected=true]", "Command Inspect branch"],
  ]) {
    if (itemRole === "menuitem")
      await page.getByRole("button", { name: "main", exact: true }).click();
    else await page.getByPlaceholder("Branch command").focus();
    const list = page.locator(`[data-slot="${slot}"]`);
    const rows = list.getByRole(itemRole);
    await rows.first().hover();
    await list.locator(marker).filter({ hasText: "Choose branch" }).waitFor();
    await list.evaluate((el) => {
      el.querySelector('[data-slot="glide"]').addEventListener("transitionrun", (event) => {
        if (event.propertyName === "transform") el.dataset.sawTravel = "";
      });
    });
    await rows.nth(1).hover();
    await page.locator(`[data-slot="${slot}"][data-saw-travel]`).waitFor();
    if (itemRole === "option") {
      await page.getByPlaceholder("Branch command").hover();
      await assertFill(list, marker, false);
      await page.keyboard.press("Enter");
      await page.getByTestId("picked").filter({ hasText: "Command Rename branch" }).waitFor();
    }
    await page.keyboard.press("ArrowDown");
    const active = list.locator(marker).filter({ hasText: "Inspect branch" });
    await active.waitFor();
    await assertFill(list, marker);
    await page.keyboard.press("Enter");
    await page.getByTestId("picked").filter({ hasText: expected }).waitFor();
    if (itemRole === "menuitem") await list.waitFor({ state: "detached" });
  }
  // A check mark does not paint a background. The focused checked option must still light.
  for (const [trigger, surface] of [
    [page.getByRole("combobox", { name: "Environment" }), "[data-radix-select-viewport]"],
    [page.getByRole("button", { name: "Target: Local" }), '[data-slot="dropdown-menu-content"]'],
  ]) {
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const list = page.locator(surface);
    const checked = "[data-state=checked][data-highlighted]";
    await list.locator(checked).filter({ hasText: "Local" }).waitFor();
    await assertFill(list, checked);
    await page.keyboard.press("ArrowDown");
    await list.locator("[data-highlighted]").filter({ hasText: "Cloud" }).waitFor();
    await assertFill(list, "[data-highlighted]");
    await page.keyboard.press("Enter");
    await list.waitFor({ state: "detached" });
    const picked =
      surface === "[data-radix-select-viewport]"
        ? page.getByRole("combobox", { name: "Environment" })
        : page.getByRole("button", { name: "Target: Cloud" });
    assert.match(await picked.innerText(), /Cloud/);
  }
  await page.getByRole("combobox", { name: "Environment" }).click();
  await page.getByRole("option", { name: "Local", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "Environment" }).textContent(), "Local");
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
  const spinner = page.getByTestId("spinner");
  assert.notEqual(await spinner.evaluate((el) => getComputedStyle(el).animationName), "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await spinner.evaluate((el) => el.getAnimations().length), 0);
  assert.equal(await primary.evaluate((el) => getComputedStyle(el).transitionDuration), "0.08s");

  // Pause at animationstart so even a slow CI machine can inspect the painted intermediate frames.
  await page.evaluate(() => {
    document.addEventListener("animationstart", ({ target, animationName }) => {
      if (!target.matches('[data-slot="dropdown-menu-content"], [data-slot="dialog-content"]'))
        return;
      target
        .getAnimations()
        .find((a) => a.animationName === animationName)
        ?.pause();
    });
  });
  for (const [trigger, slot, enter, exit] of [
    ["main", "dropdown-menu-content", 160, 120],
    ["Open dialog", "dialog-content", 240, 160],
  ]) {
    const selector = `[data-slot="${slot}"]`;
    for (const [state, duration] of [
      ["open", enter],
      ["closed", exit],
    ]) {
      if (state === "open") await page.getByRole("button", { name: trigger, exact: true }).click();
      else await page.keyboard.press("Escape");
      const surface = page.locator(`${selector}[data-state="${state}"]`);
      await page.waitForFunction(
        (s) =>
          document
            .querySelector(s)
            ?.getAnimations()
            .some((a) => a.playState === "paused"),
        `${selector}[data-state="${state}"]`
      );
      const sample = await surface.evaluate((el) => {
        const animation = el.getAnimations().find((a) => a instanceof CSSAnimation);
        const duration = animation.effect.getTiming().duration;
        const frames = [0.25, 0.75].map((fraction) => {
          animation.currentTime = fraction * duration;
          const style = getComputedStyle(el);
          return {
            opacity: Number(style.opacity),
            still:
              (style.transform === "none" || new DOMMatrixReadOnly(style.transform).isIdentity) &&
              ["none", "1"].includes(style.scale),
            bounds: el.getBoundingClientRect().toJSON(),
          };
        });
        animation.finish();
        return { duration, frames };
      });
      const [first, last] = sample.frames;
      assert.equal(sample.duration, duration, `${slot} ${state} keeps its tier`);
      assert(first.opacity > 0 && first.opacity < 1 && last.opacity > 0 && last.opacity < 1);
      assert(state === "open" ? first.opacity < last.opacity : first.opacity > last.opacity);
      assert(first.still && last.still);
      assert.deepEqual(first.bounds, last.bounds, `${slot} fades in place`);
    }
    await page.locator(selector).waitFor({ state: "detached" });
  }
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
  await mobile.getByRole("combobox", { name: "Environment" }).focus();
  await mobile.keyboard.press("ArrowDown");
  await assertFill(
    mobile.locator("[data-radix-select-viewport]"),
    "[data-state=checked][data-highlighted]"
  );
  await mobile.keyboard.press("Escape");

  const settings = await browser.newPage();
  await settings.addInitScript(() => localStorage.setItem("deus.cloudDirectWeb", "1"));
  await settings.goto(url + "#settings");
  const navigation = settings.locator('[data-slot="sidebar-content"]');
  const last = navigation.getByRole("button").last();
  await last.hover();
  await assertFill(navigation, "[data-sidebar=menu-button]:hover", false);
  const bounds = await last.boundingBox();
  await settings.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height + 200);
  const alpha = await navigation.locator('[data-slot="glide"]').evaluate(async (fill) => {
    await Promise.allSettled(fill.getAnimations().map((animation) => animation.finished));
    return getComputedStyle(fill).opacity;
  });
  assert.equal(alpha, "0", "Empty Settings space releases the hovered row");
  await last.hover();
  await assertFill(navigation, "[data-sidebar=menu-button]:hover", false);
  await navigation
    .locator("li ~ li")
    .evaluateAll((items) => items.forEach((item) => item.remove()));
  await settings.waitForFunction(() => {
    const list = document.querySelector('[data-slot="sidebar-content"]');
    return list.scrollHeight === list.querySelector("ul").offsetHeight;
  });
  await settings.close();
  const desktop = await browser.newPage();
  await desktop.goto(url + "#desktop-edge");
  assert(
    await desktop.locator('[data-slot="sidebar-hover-zone"]').evaluate((zone) => {
      const rect = zone.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === zone;
    }),
    "The collapsed desktop sidebar receives pointer input at the window edge"
  );
  await desktop.keyboard.press("Control+b");
  const grip = desktop.getByRole("separator", { name: "Resize sidebar" });
  await desktop.waitForFunction(
    () => document.querySelector('[data-slot="sidebar-gap"]').getBoundingClientRect().width === 344
  );
  const { x, y } = await grip.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x - 1, y: rect.y + rect.height / 2 };
  });
  await desktop.mouse.move(x, y);
  await desktop.mouse.down();
  await desktop.locator("[data-resizing]").waitFor();
  const dragFrames = grip.evaluate((divider) => {
    const wrapper = divider.closest('[data-slot="sidebar-wrapper"]');
    const sidebar = wrapper.querySelector('[data-slot="sidebar-container"]');
    const frames = [];
    return new Promise((resolve) => {
      function sample() {
        if (!wrapper.hasAttribute("data-resizing")) return resolve(frames);
        frames.push([divider.getBoundingClientRect().x, sidebar.getBoundingClientRect().right]);
        requestAnimationFrame(sample);
      }
      sample();
    });
  });
  await desktop.mouse.move(x + 60, y, { steps: 8 });
  await desktop.mouse.up();
  const frames = await dragFrames;
  assert(new Set(frames.map(([edge]) => edge)).size >= 3, "Sampled the grip in motion");
  assert(
    frames.every(([edge, panel]) => Math.abs(edge - panel) <= 1),
    "Sidebar follows the grip on every frame"
  );
  await desktop.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: control press stability, disabled actions, keyboard focus, glide handoff, checked select/radio targets, select/link behavior, independent tab lifetimes, reduced motion and mobile touch"
  );

  // Nothing jumps. Measure the controls in both motion settings.
  for (const reducedMotion of ["no-preference", "reduce"]) {
    const sample = await browser.newPage({ reducedMotion, permissions: ["clipboard-write"] });
    await sample.goto(url + "#no-jumps");
    const strip = sample.getByRole("tablist", { name: "Content panel" });
    const travel = await strip.evaluate(async (el) => {
      const tabs = el.querySelectorAll('[role="tab"]');
      const x = () => tabs[2].getBoundingClientRect().x;
      const before = x();
      tabs[1].click();
      await new Promise(requestAnimationFrame);
      const panel = document.querySelector('[data-testid="panel"]').textContent;
      const positions = [x()];
      while (el.getAnimations({ subtree: true }).some((a) => a instanceof CSSTransition)) {
        await new Promise(requestAnimationFrame);
        positions.push(x());
      }
      return { before, panel, positions };
    });
    assert.equal(travel.panel, "files", "The panel switches on the first frame");
    assert.notEqual(travel.before, travel.positions.at(-1));
    const steps = new Set(travel.positions).size;
    assert(
      reducedMotion === "reduce" ? steps === 1 : steps > 2,
      "Strip travel follows the motion preference"
    );

    const references = sample.getByRole("tablist", { name: "References" }).getByRole("tab");
    const fourth = await references.nth(3).boundingBox();
    await references.nth(1).click();
    assert.deepEqual(
      await references.nth(3).boundingBox(),
      fourth,
      "Changing weight holds the next tabs in place"
    );

    const cell = sample.locator('[data-slot="copy-icon"]');
    const before = await cell.boundingBox();
    await sample.getByRole("button", { name: "Copy", exact: true }).click();
    const copied = sample.getByRole("button", { name: "Copied!" });
    await copied.getByRole("status").filter({ hasText: "Copied" }).waitFor({ state: "attached" });
    assert.deepEqual(await cell.boundingBox(), before);
    const glyphs = await cell.locator("svg").evaluateAll((icons) =>
      icons.map((icon) => {
        const s = getComputedStyle(icon);
        return { duration: s.transitionDuration, moves: s.transitionProperty.includes("scale") };
      })
    );
    assert.deepEqual(
      glyphs.map((g) => g.duration),
      ["0.06s", "0.08s"]
    );
    assert(glyphs.every((g) => g.moves === (reducedMotion !== "reduce")));

    const read = await sample
      .getByRole("button", { name: "Toggle pending" })
      .evaluate(async (button) => {
        button.click();
        await Promise.resolve();
        const placeholder = document.querySelector('[data-slot="skeleton"]');
        const animations = placeholder.getAnimations();
        const fade = animations.find((a) => a.animationName === "fadeIn");
        // Inspect the last possible frame of a fast read, then let its data arrive.
        fade.pause();
        fade.currentTime = 159;
        const opacity = getComputedStyle(placeholder).opacity;
        button.click();
        await new Promise(requestAnimationFrame);
        const { delay, duration } = fade.effect.getTiming();
        return {
          opacity,
          removed: !placeholder.isConnected,
          delay,
          duration,
          pulses: animations.some((a) => a.animationName === "pulse"),
        };
      });
    assert.deepEqual(read, {
      opacity: "0",
      removed: true,
      delay: 160,
      duration: 80,
      pulses: reducedMotion !== "reduce",
    });

    const changes = strip.getByRole("tab", { name: "Changes" });
    const files = strip.getByRole("tab", { name: "Files" });
    await changes.evaluate((button) => button.click());
    await changes.hover();
    await sample.waitForTimeout(700);
    const activeDescription = await changes.getAttribute("aria-describedby");
    // Keep the pointer in the panel. Moving it to Files can dismiss the stale tooltip.
    await sample.mouse.move(900, 500);
    await files.evaluate((button) => button.click());
    await strip.getByRole("tab", { name: "Files", selected: true }).waitFor();
    await sample.waitForTimeout(700);
    assert.equal(await sample.locator('[data-slot="tooltip-content"]:visible').count(), 0);
    assert.equal(activeDescription, null);

    await changes.hover();
    const hint = sample.getByRole("tooltip", { name: "Changes" });
    await hint.waitFor();
    assert.equal(await changes.getAttribute("aria-describedby"), await hint.getAttribute("id"));
    await changes.click();
    await hint.waitFor({ state: "detached" });
    await sample.mouse.move(900, 500);
    await files.hover();
    await sample.getByRole("tooltip", { name: "Files" }).waitFor();
    await sample.close();
  }
  console.log(
    "PASS: tab strip travel, inactive tab tooltips, immediate panel selection, stable label and copy bounds, delayed skeletons in both motion settings"
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => http.close(resolve));
  await server.close();
}
