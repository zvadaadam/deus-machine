import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { until } from "../remote-access/stack.mjs";

const neighborName = "Reference project";

export function seedSidebarGestures(db, projectId, directory) {
  const neighborId = crypto.randomUUID();
  const folder = mkdtempSync(path.join(directory, "reference-"));
  db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, ?, ?)").run(
    neighborId,
    neighborName,
    folder
  );
  const workspace = db.prepare(
    "INSERT INTO workspaces (id, repository_id, slug, state, current_session_id) VALUES (?, ?, ?, 'ready', ?)"
  );
  const chat = db.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)");
  db.transaction(() => {
    for (let i = 1; i <= 30; i++) {
      const id = crypto.randomUUID(),
        session = crypto.randomUUID();
      workspace.run(id, projectId, `Follow-up ${i}`, session);
      chat.run(session, id);
    }
  })();
  return neighborId;
}

export async function assertSidebarGestures(
  page,
  { projectName, neighborId, screenshot, desktop }
) {
  const list = page.locator('[data-slot="sidebar-content"]');
  const header = page.getByLabel(`Toggle ${projectName} workspaces`, { exact: true });
  const neighbor = page.getByLabel(`Toggle ${neighborName} workspaces`, { exact: true });
  const group = header.locator("xpath=ancestor::div[@data-slot='collapsible'][1]");
  const rows = group.locator("[data-workspace-id]");
  const menu = page.locator('[role="menu"]');
  const preview = page.locator('[data-slot="hover-card-content"][data-state="open"]');
  const projectOrder = () =>
    list
      .locator('[data-slot="collapsible-trigger"][data-sidebar-row]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  await neighbor.waitFor();
  if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
  await until(async () => (await rows.count()) >= 30);
  const count = await rows.count();
  const middle = group
    .locator('[data-workspace-id]:not([aria-current="page"])')
    .nth(Math.floor(count / 2));
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, point) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: point ? [point] : [],
    });
  const point = async (target) => {
    const box = await target.boundingBox();
    assert(box);
    return {
      x: Math.round(box.x + Math.min(box.width / 2, 90)),
      y: Math.round(box.y + box.height / 2),
    };
  };
  const noDrag = async (order) => {
    assert.equal(await header.getAttribute("aria-expanded"), "true");
    assert.notEqual(await header.getAttribute("aria-pressed"), "true");
    assert.deepEqual(await projectOrder(), order);
  };
  try {
    if (desktop) await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    const initialOrder = await projectOrder();
    await middle.scrollIntoViewIfNeeded();
    assert.notEqual(await middle.getAttribute("aria-current"), "page");
    const start = await point(middle);
    assert(
      await middle.evaluate(
        (el, { x, y }) => el.contains(el.ownerDocument.elementFromPoint(x, y)),
        start
      )
    );
    await page.mouse.move(start.x, start.y);
    await touch("touchStart", start);
    const begin = Date.now();
    const samples = [];
    for (const at of [100, 440, 900]) {
      await page.waitForTimeout(Math.max(0, at - (Date.now() - begin)));
      const state = await header.evaluate((el) => ({
        expanded: el.getAttribute("aria-expanded"),
        dragging: el.getAttribute("aria-pressed") === "true",
        rows: el.closest('[data-slot="collapsible"]').querySelectorAll("[data-workspace-id]")
          .length,
        menu: Boolean(el.ownerDocument.querySelector('[role="menu"][data-state="open"]')),
        preview: Boolean(
          el.ownerDocument.querySelector('[data-slot="hover-card-content"][data-state="open"]')
        ),
      }));
      samples.push({ ms: Date.now() - begin, ...state });
    }
    console.log(
      "Workspace hold",
      JSON.stringify({
        url: page.url(),
        viewport: await page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]),
        row: await middle.getAttribute("aria-label"),
        point: start,
        samples,
      })
    );
    assert(samples.every((s) => s.rows === count && s.expanded === "true" && !s.dragging));
    assert(samples.at(-1).menu && !samples.at(-1).preview);
    const copy = menu.getByRole("menuitem", { name: "Copy link", exact: true });
    await copy.waitFor();
    await page.screenshot({ path: screenshot });
    await touch("touchEnd");
    const heldItem = await point(copy);
    await touch("touchStart", heldItem);
    await page.waitForTimeout(320);
    await touch("touchMove", { ...heldItem, x: heldItem.x + 12 });
    await noDrag(initialOrder);
    await touch("touchCancel");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });

    const scrollTop = () => list.evaluate((el) => el.scrollTop);
    const before = await scrollTop();
    const swipe = await point(middle);
    await touch("touchStart", swipe);
    await touch("touchMove", { ...swipe, y: swipe.y - 60 });
    await touch("touchMove", { ...swipe, y: swipe.y - 120 });
    await touch("touchEnd");
    await until(
      async () => (await scrollTop()) > before + 20,
      4000,
      "touch scrolling from a workspace row"
    );
    console.log("Workspace swipe", before, "to", await scrollTop());
    await noDrag(initialOrder);
    assert.equal(await menu.count(), 0);

    if (desktop) {
      const selected = page.url();
      await middle.hover();
      await preview.waitFor();
      await page.mouse.move(2, 2);
      await preview.waitFor({ state: "detached" });
      const p = await point(middle);
      await page.mouse.move(p.x, p.y);
      await page.mouse.click(p.x, p.y, { button: "right" });
      await copy.waitFor();
      await page.waitForTimeout(600);
      assert.equal(await preview.count(), 0, "A delayed hover card opened beside the menu");
      const item = await point(copy);
      await page.mouse.move(item.x, item.y);
      await page.mouse.down();
      await page.mouse.move(item.x + 12, item.y, { steps: 3 });
      await noDrag(initialOrder);
      await page.mouse.move(2, 2);
      await page.mouse.up();
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      const ctrl = await point(middle);
      await page.mouse.move(ctrl.x, ctrl.y);
      await page.keyboard.down("Control");
      await page.mouse.down();
      await page.mouse.move(ctrl.x + 12, ctrl.y, { steps: 3 });
      await noDrag(initialOrder);
      await page.mouse.move(2, 2);
      await page.mouse.up();
      await page.keyboard.up("Control");
      if (await menu.count()) await page.keyboard.press("Escape");
      await noDrag(initialOrder);
      assert.equal(page.url(), selected);
      console.log(
        "PASS hover preview alone, right-click menu alone, menu drag and moving Ctrl-click keep project in place"
      );
    }

    // Both headers fit in the sidebar when collapsed.
    await header.click();
    if ((await neighbor.getAttribute("aria-expanded")) === "true") await neighbor.click();
    await list.locator('[data-slot="collapsible"] ul').first().waitFor({ state: "detached" });
    assert.equal(
      await page
        .getByRole("button", { name: `Toggle ${projectName} workspaces`, exact: true })
        .count(),
      1
    );
    for (const input of desktop ? ["touch", "mouse", "keyboard"] : ["touch"]) {
      await list.evaluate((el) =>
        Promise.allSettled(
          el.getAnimations({ subtree: true }).map((animation) => animation.finished)
        )
      );
      const previous = await projectOrder();
      const from = await point(header),
        to = await point(neighbor);
      if (input === "touch") await touch("touchStart", from);
      if (input === "keyboard") {
        await header.focus();
        await page.keyboard.press("Space");
      }
      if (input === "mouse") {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + 8, from.y);
      }
      await until(
        async () => (await header.getAttribute("aria-pressed")) === "true",
        4000,
        input + " project drag"
      );
      if (input === "keyboard") {
        // The first collision announces that the project rectangles are measured.
        await list.getByText(/was moved over droppable area/).waitFor({ state: "attached" });
        const key =
          previous[0] === (await header.getAttribute("aria-label")) ? "ArrowDown" : "ArrowUp";
        await page.keyboard.press(key);
      }
      if (input === "mouse") await page.mouse.move(to.x, to.y, { steps: 6 });
      if (input === "touch") await touch("touchMove", to);
      await list
        .locator('[aria-live="assertive"]')
        .filter({ hasText: "was moved over droppable area " + neighborId })
        .waitFor({ state: "attached" });
      if (input === "keyboard") await page.keyboard.press("Space");
      if (input === "mouse") await page.mouse.up();
      if (input === "touch") await touch("touchEnd");
      await until(
        async () => (await projectOrder())[0] === previous[1],
        4000,
        input + " project reorder"
      );
      console.log("PASS project header reordered by", input);
    }
    if (desktop) {
      await page
        .getByRole("button", { name: `New workspace in ${projectName}`, exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await page.getByPlaceholder("Describe what you'd like to do...").waitFor();
      assert.equal(await header.getAttribute("aria-expanded"), "false");
      console.log("PASS Enter on the project header’s New workspace button opened Home");
    }
  } finally {
    await cdp.detach();
  }
}
