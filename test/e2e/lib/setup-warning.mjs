/* global document, getComputedStyle */
import assert from "node:assert/strict";
import path from "node:path";

// The agentless journey can render a real transcript tool by reading a finished
// turn from its disposable database. No chat or tool is executed to make the fixture.
export function seedToolTurn(db, sessionId) {
  const turn = crypto.randomUUID();
  const prompt = { type: "text", state: "done", text: "Check the workspace setup log." };
  const read = {
    type: "tool",
    kind: "read",
    toolName: "Read",
    toolCallId: crypto.randomUUID(),
    state: { status: "failed", input: { file_path: "setup.log" }, error: "File not found." },
  };
  db.transaction(() => {
    for (const [role, part] of [
      ["user", prompt],
      ["assistant", read],
    ]) {
      const message = crypto.randomUUID(),
        id = crypto.randomUUID();
      db.prepare(
        "INSERT INTO messages (id, session_id, role, turn_id, sent_at) VALUES (?, ?, ?, ?, ?)"
      ).run(message, sessionId, role, turn, new Date().toISOString());
      db.prepare(
        "INSERT INTO parts (id, message_id, session_id, type, data, tool_call_id, tool_name) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        id,
        message,
        sessionId,
        part.type,
        JSON.stringify({ ...part, id }),
        part.toolCallId ?? null,
        part.toolName ?? null
      );
    }
    const now = Date.now();
    db.prepare(
      "INSERT INTO turns (session_id, turn_id, started_at, ended_at, outcome) VALUES (?, ?, ?, ?, ?)"
    ).run(sessionId, turn, now, now, JSON.stringify({ stopReason: "end_turn" }));
  })();
}

export async function checkSetupWarning(page, group, evidence, touch = false) {
  const title = group.getByRole("button", { name: "Workspace ready", exact: true });
  const issue = group.getByRole("button", { name: /^Setup failed/ });
  const retry = group.getByRole("button", { name: "Run again" });
  const log = group.getByRole("button", { name: "View log" });
  const output = group.locator("pre:visible");
  const lastLine = "Missing <b>clang</b>";
  const sentence =
    "Setup exited with code 1. The agent can see the error, and you can keep working.";
  await issue.waitFor();
  assert.equal(await issue.locator("samp").textContent(), lastLine);
  assert.equal(await issue.locator("b").count(), 0);
  assert.equal(await group.getAttribute("aria-live"), "polite");
  assert.equal(await title.getAttribute("aria-expanded"), "false");
  await page.bringToFront();
  await page.mouse.move(page.viewportSize().width - 120, page.viewportSize().height / 2);
  const clearFocus = () => page.evaluate(() => document.activeElement?.blur());
  await clearFocus();
  await page.locator('[data-slot="hover-card-content"]').waitFor({ state: "hidden" });
  for (const theme of touch ? ["dark"] : ["dark", "light"]) {
    await page.emulateMedia({
      colorScheme: theme,
      reducedMotion: touch ? "reduce" : "no-preference",
    });
    await page.waitForFunction((name) => document.documentElement.classList.contains(name), theme);
    await page.locator("html:not([data-theme-switching])").waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await output.count(), 0);
    if (!touch) await page.screenshot({ path: path.join(evidence, `setup-closed-${theme}.png`) });
    await issue.press("Enter");
    await group.getByText(sentence, { exact: true }).waitFor();
    await clearFocus();
    assert.equal(await output.innerText(), "Checking tools\n" + lastLine);
    assert.equal(await output.locator("b").count(), 0);
    if (!touch) await page.screenshot({ path: path.join(evidence, `setup-open-${theme}.png`) });
    if (theme === "dark") {
      const tool = page.getByRole("button", { name: "Expand Read tool details" });
      const iconX = (await tool.locator(".relative").boundingBox()).x;
      const labelX = (await tool.getByText("Read", { exact: true }).boundingBox()).x;
      for (const [node, edge] of [
        [title.locator("svg").first(), iconX],
        [issue.locator("svg").first(), iconX],
        [title.getByText("Workspace ready"), labelX],
        [issue.getByText("Setup failed"), labelX],
        [group.getByText(sentence), labelX],
        [output, labelX],
        [log, labelX],
      ]) {
        assert(
          Math.abs((await node.boundingBox()).x - edge) < 0.5,
          "aligned with the transcript tool"
        );
      }
      // A linked file adds a badge to this particular Read. Measure the tool's
      // single text line and vertical padding independently of that accessory.
      const toolLineHeight = await tool.evaluate((el) => {
        const css = getComputedStyle(el);
        return (
          parseFloat(css.lineHeight) + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom)
        );
      });
      assert.equal((await issue.boundingBox()).height, touch ? 44 : toolLineHeight);
      if (touch) {
        const bounds = await retry.boundingBox();
        assert(bounds.x + bounds.width <= page.viewportSize().width);
        assert(
          await retry.evaluate((el) => {
            const r = el.getBoundingClientRect(),
              x = r.x + r.width / 2,
              y = r.y + r.height / 2;
            return [y - 21, y + 21].every((at) => el.contains(document.elementFromPoint(x, at)));
          }),
          "separate 44px retry target"
        );
        assert(
          await issue
            .locator("samp")
            .evaluate(
              (el) =>
                el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === "ellipsis"
            )
        );
      }
      const top = (await group.boundingBox()).y - 4;
      const bottom = (await tool.boundingBox()).y + (await tool.boundingBox()).height + 4;
      const guide = `position: fixed; content: ""; pointer-events: none; z-index: 1000; top: ${top}px; height: ${bottom - top}px; border-left: 1px dashed color-mix(in oklch, var(--info) 46%, transparent)`;
      await page.screenshot({
        path: path.join(evidence, touch ? "setup-grid-mobile.png" : "setup-grid.png"),
        style: `body::before { ${guide}; left: ${iconX}px } body::after { ${guide}; left: ${labelX}px }`,
      });
    }
    await issue.press("Space");
    await clearFocus();
  }
  if (!touch) {
    await issue.press("Enter");
    const [popup] = await Promise.all([page.context().waitForEvent("page"), log.press("Enter")]);
    await popup.waitForLoadState();
    assert((await popup.locator("body").innerText()).includes(lastLine));
    assert.equal(await popup.locator("b").count(), 0);
    await popup.close();
    await issue.press("Space");
  }
}
