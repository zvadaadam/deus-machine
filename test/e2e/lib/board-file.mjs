import assert from "node:assert/strict";

export async function openBoardReport(page, workspace, title, archived = false) {
  const address = page.url();
  const thread = page.getByRole("complementary", { name: "Thread" });
  const chip = thread.getByRole("button", { name: "report.md .context", exact: true });
  assert.equal(await chip.getAttribute("href"), null);
  await chip.click();
  const viewer = page.getByRole("dialog");
  await viewer
    .getByRole("heading", { name: workspace + (archived ? " · archived" : ""), exact: true })
    .waitFor();
  await viewer.getByRole("heading", { name: title, exact: true }).waitFor();
  await viewer
    .getByRole("button", { name: archived ? "Restore workspace" : "Open in workspace" })
    .waitFor();
  assert.equal(page.url(), address);
  return viewer;
}
