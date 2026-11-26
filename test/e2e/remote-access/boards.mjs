import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { boardChatTurn } from "./board-fixture.mjs";

export async function testRelayedBoard({
  boardChatId,
  phone,
  secondTab,
  desktop,
  desktopBase,
  hostDb,
  hostWrite,
  machineId,
  output,
}) {
  // Vite's query inspector occupies the phone's Send button; the shipped app has no inspector.
  const hideInspector = { content: ".tsqd-parent-container{display:none!important}" };
  await phone.addStyleTag(hideInspector);
  const row = phone
    .getByRole("region", { name: "Boards" })
    .getByRole("button", { name: /remote-release/ });
  await phone.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await row.click();
  const channel = phone.getByRole("region", { name: "Channel messages" });
  const root = "The release candidate is ready for review.";
  await channel.getByText(root, { exact: true }).waitFor();
  await channel.getByText("The smoke checks passed on the fixture Mac.", { exact: true }).waitFor();
  const address = new URL(phone.url());
  assert.equal(address.pathname.split("/").slice(0, 4).join("/"), `/s/${machineId}/b`);
  assert.match(address.pathname.split("/")[4], /^[a-f\d-]{36}$/i);
  await channel.getByRole("button", { name: "1 reply", exact: true }).click();
  const thread = phone.getByRole("complementary", { name: "Thread" });
  await thread.getByText(root, { exact: true }).waitFor();
  await thread.getByText("The release notes are ready to check.", { exact: true }).waitFor();
  await boardChatTurn(hostWrite, boardChatId, "Wait for the paired phone");
  const documentStarted = () => phone.evaluate(() => performance.timeOrigin);
  const started = await documentStarted();
  const reply = thread.getByRole("textbox", { name: "Reply…" });
  await reply.fill("Which check comes next?");
  await thread.getByRole("button", { name: "Send reply" }).click();
  await thread.getByRole("link", { name: "Queued for Coordinator · Release room" }).waitFor();
  await writeFile(path.join(hostDb.dir, "release-coordinator"), "");
  const receipt = thread.getByRole("link", { name: "Sent to Coordinator · Release room" }).first();
  await receipt.waitFor();
  assert.equal(new URL(await receipt.getAttribute("href")).searchParams.get("session"), boardChatId);
  await thread.getByText("Please check the release notes on the phone.", { exact: true }).waitFor();
  assert.equal(await documentStarted(), started);
  await phone.getByRole("button", { name: "Back to channel" }).click();
  await phone.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await row.waitFor();
  assert.equal(await row.getByLabel("Unread posts").count(), 0);
  await row.click();
  await channel.getByRole("button", { name: "3 replies" }).click();
  await desktop.goto(desktopBase + "s/local/b/" + address.pathname.split("/")[4] + "?thread=1");
  await desktop.addStyleTag(hideInspector);
  const desktopThread = desktop.getByRole("complementary", { name: "Thread" });
  const update = "Release notes checked on the desktop.";
  await desktopThread.getByRole("textbox", { name: "Reply…" }).fill(update);
  await desktopThread.getByRole("button", { name: "Send reply" }).click();
  await thread.getByText(update, { exact: true }).waitFor();
  await thread
    .getByRole("article")
    .filter({ hasText: update })
    .getByRole("link", { name: "Sent to Coordinator · Release room" })
    .waitFor();
  assert.equal(await documentStarted(), started);
  await phone.screenshot({
    path: path.join(output, "board-relay-phone.png"),
    animations: "disabled",
  });
  await receipt.click();
  await phone.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await row.getByLabel("Unread posts").waitFor();
  await row.click();
  await phone.reload();
  await channel.getByText(root, { exact: true }).waitFor();
  assert.equal(phone.url(), address.href);
  await secondTab.goto(address.href);
  await secondTab
    .getByRole("region", { name: "Channel messages" })
    .getByText(root, { exact: true })
    .waitFor();
  assert.equal(secondTab.url(), address.href);
}
