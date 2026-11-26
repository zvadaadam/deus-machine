/* global document, getComputedStyle, innerWidth, requestAnimationFrame, CSSAnimation, CSSTransition, DOMMatrixReadOnly, MutationObserver */
// Exercise the real control primitives with mouse, keyboard and touch layouts.
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";
import { expect } from "playwright/test";

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
 <DropdownMenu><DropdownMenuTrigger asChild><Button variant="secondary">Target: {target}</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuRadioGroup value={target} onValueChange={setTarget}>{["Cloud","Local"].map(place=><DropdownMenuRadioItem key={place} value={place}>{place}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
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
import { WorkspaceTabBar } from "@/features/workspace-tabs";
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
 const [tabs, setTabs] = useState([
   { id: "t-changes", kind: "changes" as const },
   { id: "t-files", kind: "files" as const },
 ]);
 const [activeTabId, setActiveTabId] = useState("t-changes");
 const [pending, setPending] = useState(false);
 return <QueryClientProvider client={client}><TooltipProvider>
   <WorkspaceTabBar
     workspaceId="controls"
     tabs={tabs}
     activeTabId={activeTabId}
     onTabSelect={setActiveTabId}
     onTabClose={(id) => setTabs((prev) => prev.filter((t) => t.id !== id))}
     onTabAdd={() => {}}
     onTabReorder={(draggedId, targetId) =>
       setTabs((prev) => {
         const from = prev.findIndex((t) => t.id === draggedId);
         const to = prev.findIndex((t) => t.id === targetId);
         if (from === -1 || to === -1) return prev;
         const next = [...prev];
         const [moved] = next.splice(from, 1);
         next.splice(to, 0, moved);
         return next;
       })
     }
   />
   <output data-testid="panel">{tabs.find((t) => t.id === activeTabId)?.kind}</output>
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
const http = createHttpServer();
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
  // Keep Vite's client on the fixture's own port when other runners are open.
  server: { middlewareMode: true, hmr: { server: http }, watch: null },
});
http.on("request", server.middlewares);
function assertSameBounds(before, after, message) {
  for (const key of ["x", "y", "width", "height"])
    assert(
      Math.abs(before[key] - after[key]) < 0.5,
      `${message} (${key}: ${before[key]} → ${after[key]})`
    );
}
async function waitForFunction(page, message, predicate, arg) {
  try {
    await page.waitForFunction(predicate, arg);
  } catch (cause) {
    throw new Error(message, { cause });
  }
}
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
  await expect(primary.and(page.locator(":active"))).toBeVisible();
  await primary.evaluate((el) => Promise.allSettled(el.getAnimations().map((a) => a.finished)));
  assertSameBounds(
    before,
    await primary.boundingBox(),
    "Pressing does not move the control or scale its label"
  );
  await page.mouse.up();
  await page.getByText("Actions: 1", { exact: true }).waitFor();
  const disabled = page.getByRole("button", { name: "Disabled", exact: true });
  assert(await disabled.isDisabled());
  await disabled.dispatchEvent("click");
  assert.equal(await page.getByText("Actions: 1", { exact: true }).count(), 1);
  await primary.focus();
  await page.keyboard.press("Tab");
  const secondary = page.getByRole("button", { name: "secondary", exact: true });
  await expect(secondary.and(page.locator(":focus-visible"))).toBeFocused();
  await expect(secondary).not.toHaveCSS("box-shadow", "none");
  await page.getByRole("button", { name: "main", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("menuitem", { name: "Choose branch" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("menuitem", { name: "Choose branch" }).waitFor({ state: "detached" });
  await expect(page.getByRole("button", { name: "main", exact: true })).toBeFocused();
  async function assertFill(list, marker, shouldSnap = true) {
    const fill = list.locator('[data-slot="glide"][data-lit]');
    const row = list.locator(marker);
    await expect(row).toBeVisible();
    await expect(fill).toHaveCSS("opacity", "1");
    if (shouldSnap) await expect(fill).not.toHaveCSS("transition-property", /transform/);
    await expect
      .poll(
        () =>
          list.evaluate((el, selector) => {
            const painted = el.querySelector('[data-slot="glide"]').getBoundingClientRect();
            const target = el.querySelector(selector)?.getBoundingClientRect();
            return target ? Math.abs(painted.top - target.top) : Infinity;
          }, marker),
        { message: "The fill paints the marked row" }
      )
      .toBeLessThan(1);
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
    await assertFill(list, marker, false);
    await list.evaluate((el) => {
      el.querySelector('[data-slot="glide"]').addEventListener("transitionrun", (event) => {
        if (event.propertyName === "transform") el.dataset.sawTravel = "";
      });
    });
    await rows.nth(1).hover();
    await list.locator(marker).filter({ hasText: "Rename branch" }).waitFor();
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
  // Select opens on its value. A radio menu can open on an unchecked item.
  await page.mouse.move(0, 0);
  for (const [trigger, surface, role] of [
    [page.getByRole("combobox", { name: "Environment" }), "[data-radix-select-viewport]", "option"],
    [
      page.getByRole("button", { name: /^Target: / }),
      '[data-slot="dropdown-menu-content"]',
      "menuitemradio",
    ],
  ]) {
    await trigger.press("ArrowDown");
    const list = page.locator(surface);
    const focused = "[data-highlighted]:focus";
    await assertFill(list, focused);
    if (role === "menuitemradio") {
      const checked = await list.getByRole(role, { checked: true }).innerText();
      await page.keyboard.press(checked.trim()[0].toLowerCase());
    }
    await assertFill(list, focused + "[data-state=checked]");
    const last = list.getByRole(role).last();
    await page.keyboard.press(
      (await last.getAttribute("data-state")) === "checked" ? "ArrowUp" : "ArrowDown"
    );
    const other = focused + "[data-state=unchecked]";
    await assertFill(list, other);
    const choice = (await list.locator(other).innerText()).trim();
    await page.keyboard.press("Enter");
    await list.waitFor({ state: "detached" });
    await expect(trigger).toContainText(choice);
    // Radix restores focus asynchronously after removing the popup.
    await expect(trigger).toBeFocused();
  }
  await page.getByRole("combobox", { name: "Environment" }).click();
  await page.getByRole("option", { name: "Local", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Environment" })).toHaveText("Local");
  await page.getByRole("link", { name: "Link action" }).click();
  await expect(page, "Button asChild preserves link behavior").toHaveURL(/#target$/);
  const survivingTab = page.getByTestId("second-tabs").getByRole("tab", { name: "First" });
  const indicator = () =>
    survivingTab.evaluate((el) => {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.fillStyle = getComputedStyle(el, "::after").backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    });
  const color = await indicator();
  assert(color[3] > 0);
  await page.getByRole("button", { name: "Toggle first tab set" }).click();
  assert.deepEqual(
    await indicator(),
    color,
    "Unmounting another tab set preserves this active indicator"
  );
  await survivingTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByTestId("second-tabs").getByRole("tab", { name: "Second" })
  ).toHaveAttribute("aria-selected", "true");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(async (t) => {
      document.documentElement.classList.toggle("dark", t === "dark");
      await new Promise(requestAnimationFrame);
      await Promise.allSettled(
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
  await expect(spinner).not.toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => spinner.evaluate((el) => el.getAnimations().length)).toBe(0);
  await expect(primary).toHaveCSS("transition-duration", "0.08s");

  // Start paused: a busy renderer can deliver animationstart and animationend in one frame.
  await page.addStyleTag({
    content:
      '[data-slot="dropdown-menu-content"], [data-slot="dialog-content"] { animation-play-state: paused !important }',
  });
  // A surface can paint before Radix handles Escape. Use each surface's own close action.
  const renameBranch = page.getByRole("menuitem", { name: "Rename branch" });
  const closeDialog = page.getByRole("button", { name: "Close", exact: true });
  for (const [trigger, slot, enter, exit, close] of [
    ["main", "dropdown-menu-content", 160, 120, renameBranch],
    ["Open dialog", "dialog-content", 240, 160, closeDialog],
  ]) {
    const selector = `[data-slot="${slot}"]`;
    for (const [state, duration] of [
      ["open", enter],
      ["closed", exit],
    ]) {
      if (state === "open") await page.getByRole("button", { name: trigger, exact: true }).click();
      else await close.press("Enter");
      const surface = page.locator(`${selector}[data-state="${state}"]`);
      await waitForFunction(
        page,
        `Waiting for the ${slot} ${state} animation to pause`,
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
      assertSameBounds(first.bounds, last.bounds, `${slot} fades in place`);
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
  await mobile.getByText("Actions: 1", { exact: true }).waitFor();
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
  await expect(
    navigation.locator('[data-slot="glide"]'),
    "Empty Settings space releases the hovered row"
  ).toHaveCSS("opacity", "0");
  await last.hover();
  await assertFill(navigation, "[data-sidebar=menu-button]:hover", false);
  await navigation
    .locator("li ~ li")
    .evaluateAll((items) => items.forEach((item) => item.remove()));
  await waitForFunction(settings, "Waiting for the Settings list to shrink to one row", () => {
    const list = document.querySelector('[data-slot="sidebar-content"]');
    return list.scrollHeight === list.querySelector("ul").offsetHeight;
  });
  await settings.close();
  const desktop = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await desktop.mouse.move(600, 400);
  await desktop.goto(url + "#desktop-edge");
  const zone = desktop.locator('.electron [data-state=collapsed] [data-slot="sidebar-hover-zone"]');
  await expect(zone).toBeVisible();
  assert(
    await zone.evaluate((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return document.elementFromPoint(x + width / 2, y + height / 2) === el;
    }),
    "The collapsed desktop sidebar receives pointer input at the window edge"
  );
  await desktop.keyboard.press("Control+b");
  const grip = desktop.getByRole("separator", { name: "Resize sidebar" });
  const gap = desktop.locator('[data-state=expanded] [data-slot="sidebar-gap"]');
  await expect
    .poll(() =>
      gap.evaluate((el) =>
        Math.abs(
          el.getBoundingClientRect().width -
            parseFloat(getComputedStyle(el).getPropertyValue("--sidebar-width"))
        )
      )
    )
    .toBeLessThan(0.5);
  const hit = await grip.locator(":scope > div").first().boundingBox();
  const x = hit.x + hit.width / 2,
    y = hit.y + hit.height / 2;
  await desktop.mouse.move(x, y);
  await desktop.mouse.down();
  await expect(desktop.locator('[data-resizing] [data-slot="sidebar-container"]')).toHaveCSS(
    "transition-property",
    "none"
  );
  const dragFrames = await grip.evaluateHandle((divider) => {
    const wrapper = divider.closest('[data-slot="sidebar-wrapper"]');
    const sidebar = wrapper.querySelector('[data-slot="sidebar-container"]');
    const frames = [];
    function sample() {
      if (!wrapper.hasAttribute("data-resizing")) return;
      frames.push([divider.getBoundingClientRect().x, sidebar.getBoundingClientRect().right]);
      requestAnimationFrame(sample);
    }
    sample();
    return frames;
  });
  await desktop.mouse.move(x + 60, y, { steps: 8 });
  await expect
    .poll(() =>
      dragFrames.evaluate((frames, target) => Math.abs(frames.at(-1)[0] - target), x + 60)
    )
    .toBeLessThanOrEqual(1);
  await desktop.mouse.up();
  const frames = await dragFrames.jsonValue();
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
    await sample.clock.install();
    await sample.goto(url + "#no-jumps");
    const strip = sample.getByRole("tablist", { name: "Workspace tabs" });
    const files = strip.getByRole("tab", { name: "Files" });
    const panel = sample.getByTestId("panel");
    const timeline = await sample.context().newCDPSession(sample);
    // Hold the CSS timeline while input and React continue normally.
    await timeline.send("Animation.setPlaybackRate", { playbackRate: 0 });
    await files.evaluate((tab) => {
      const selected = new MutationObserver(() => {
        tab.dataset.panelAtSelection = document.querySelector('[data-testid="panel"]').textContent;
        selected.disconnect();
      });
      selected.observe(tab, { attributeFilter: ["aria-selected"] });
    });
    await files.click();
    await expect(files).toHaveAttribute("data-panel-at-selection", "files");
    await expect(panel).toHaveText("files");

    const references = sample.getByRole("tablist", { name: "References" }).getByRole("tab");
    const fourth = await references.nth(3).boundingBox();
    await references.nth(1).click();
    await expect(references.nth(1)).toHaveAttribute("aria-selected", "true");
    assertSameBounds(
      fourth,
      await references.nth(3).boundingBox(),
      "Changing weight holds the next tabs in place"
    );

    const cell = sample.locator('[data-slot="copy-icon"]');
    const before = await cell.boundingBox();
    await sample.getByRole("button", { name: "Copy", exact: true }).click();
    const copied = sample.getByRole("button", { name: "Copied!" });
    await copied.getByRole("status").filter({ hasText: "Copied" }).waitFor({ state: "attached" });
    assertSameBounds(before, await cell.boundingBox(), "Copy feedback holds its bounds");
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

    const pending = sample.getByRole("button", { name: "Toggle pending" });
    await pending.click();
    const skeleton = sample.locator('[data-slot="skeleton"]');
    await expect
      .poll(() => skeleton.evaluate((el) => el.getAnimations().map((a) => a.animationName)))
      .toContain("fadeIn");
    const read = await skeleton.evaluate((placeholder) => {
      const animations = placeholder.getAnimations();
      const fade = animations.find((a) => a.animationName === "fadeIn");
      // Inspect the last possible frame of a fast read, then let its data arrive.
      fade.pause();
      const { delay, duration } = fade.effect.getTiming();
      fade.currentTime = delay - 1;
      const opacity = getComputedStyle(placeholder).opacity;
      return {
        opacity,
        delay,
        duration,
        pulses: animations.some((a) => a.animationName === "pulse"),
      };
    });
    assert.deepEqual(read, {
      opacity: "0",
      delay: 160,
      duration: 80,
      pulses: reducedMotion !== "reduce",
    });
    await pending.click();
    await skeleton.waitFor({ state: "detached" });
    await timeline.send("Animation.setPlaybackRate", { playbackRate: 1 });

    const changes = strip.getByRole("tab", { name: "Changes" });
    await changes.evaluate((button) => button.click());
    await expect(changes).toHaveAttribute("aria-selected", "true");
    await changes.hover();
    await sample.clock.runFor(700);
    await expect(changes).not.toHaveAttribute("aria-describedby", /.+/);
    // Keep the pointer in the panel. Moving it to Files can dismiss the stale tooltip.
    await panel.hover();
    await files.evaluate((button) => button.click());
    await strip.getByRole("tab", { name: "Files", selected: true }).waitFor();
    await sample.clock.runFor(700);
    await expect(sample.locator('[data-slot="tooltip-content"]:visible')).toHaveCount(0);

    await changes.hover();
    const hint = sample.getByRole("tooltip", { name: "Changes" });
    await hint.waitFor();
    await expect(changes).toHaveAttribute("aria-describedby", await hint.getAttribute("id"));
    await sample.screenshot({ path: path.join(artifacts, `tabs-${reducedMotion}.png`) });
    await changes.click();
    await hint.waitFor({ state: "detached" });
    await panel.hover();
    await files.hover();
    await sample.getByRole("tooltip", { name: "Files" }).waitFor();
    await sample.close();
  }
  console.log(
    "PASS: tab strip travel, inactive tab tooltips, immediate panel selection, stable label and copy bounds, delayed skeletons in both motion settings"
  );
} finally {
  await browser?.close();
  await server.close();
  await new Promise((resolve) => http.close(resolve));
}
