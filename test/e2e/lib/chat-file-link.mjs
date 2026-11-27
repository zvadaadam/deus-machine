import assert from "node:assert/strict";

// Put the link in the middle of a scrollable reply so a remount or jump to latest is observable.
const checks = Array.from({ length: 20 }, (_, i) => `Release check ${i + 1} passed.`).join("\n\n");
export const reportReply =
  checks + "\n\n[Read the release report](.context/report.md)\n\n" + checks;

export async function checkPhoneChatFile(phone) {
  const chat = phone.getByRole("log");
  const link = chat.getByRole("link", { name: "Read the release report" });
  await link.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const top = await chat.evaluate((el) => el.scrollTop);
  assert.ok(top > 0);
  const url = phone.url();
  await link.tap();
  const viewer = phone.getByRole("dialog");
  await viewer.getByRole("heading", { name: "Release verification" }).waitFor();
  await phone.goBack();
  await viewer.waitFor({ state: "detached" });
  await link.waitFor();
  assert.equal(phone.url(), url);
  assert.ok(Math.abs((await chat.evaluate((el) => el.scrollTop)) - top) <= 1);
  await phone.goForward();
  await viewer.getByRole("heading", { name: "Release verification" }).waitFor();
  await viewer.getByRole("button", { name: "Close", exact: true }).click();
  await viewer.waitFor({ state: "detached" });
}
