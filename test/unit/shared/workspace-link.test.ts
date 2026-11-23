import { describe, expect, it } from "vitest";
import { isWorkspaceLinkId, parseWorkspaceLink, workspaceLink } from "@shared/workspace-link";
import { uuidv7 } from "@shared/lib/uuid";

const workspaceId = "019adc01-16d0-7654-abcd-aabbccddeeff";
const sessionId = "019adc01-16d1-7abc-9321-001122334455";
const address = `deus://workspace?id=${workspaceId}`;
const v4Id = "550e8400-e29b-41d4-a716-446655440000";
const otherVariant = workspaceId.replace("-abcd-", "-cbcd-");
const upperId = workspaceId.toUpperCase();
const mixedId = "019aDc01-16d1-fAbC-0321-aAbBcCdDeEfF";

describe("a desktop workspace link", () => {
  it.each([
    [{ workspaceId }, address],
    [{ workspaceId, sessionId }, `${address}&session=${sessionId}`],
    [
      { workspaceId: v4Id, sessionId: otherVariant },
      `deus://workspace?id=${v4Id}&session=${otherVariant}`,
    ],
    [
      { workspaceId: upperId, sessionId: mixedId },
      `deus://workspace?id=${upperId}&session=${mixedId}`,
    ],
  ] as const)("copies and opens the same ids", (link, expected) => {
    for (const id of Object.values(link)) expect(isWorkspaceLinkId(id)).toBe(true);
    const written = workspaceLink(link);
    expect(written).toBe(expected);
    expect(parseWorkspaceLink(written)).toEqual(link);
    expect(parseWorkspaceLink(expected.replace("workspace?", "workspace/?"))).toEqual(link);
  });

  it("accepts the ids the host mints", () => {
    const link = { workspaceId: uuidv7(), sessionId: uuidv7() };
    expect(parseWorkspaceLink(workspaceLink(link))).toEqual(link);
  });

  it.each([
    ["another scheme", address.replace("deus:", "https:")],
    ["another host", address.replace("//workspace", "//chat")],
    ["a path", address.replace("?", "/file?")],
    ["a normalized path", address.replace("?", "/tmp/../?")],
    ["a double slash", address.replace("?", "//?")],
    ["a fragment", `${address}#chat`],
    ["an empty fragment", `${address}#`],
    ["credentials", address.replace("//", "//user:pass@")],
    ["an empty authority user", address.replace("//", "//@")],
    ["a port", address.replace("?", ":443?")],
    ["a second id", `${address}&id=${workspaceId}`],
    ["a second session", `${address}&session=${sessionId}&session=${sessionId}`],
    ["no workspace", `deus://workspace?session=${sessionId}`],
    ["an extra field", `${address}&work=true`],
    ["an empty field", `${address}&`],
    ["an empty id", "deus://workspace?id="],
    ["an empty session", `${address}&session=`],
    ["a malformed id", "deus://workspace?id=wrong"],
    ["a malformed session", `${address}&session=wrong`],
    ["a slash in the id", `${address}/file`],
    ["dot components", "deus://workspace?id=.."],
    ["an encoded slash", `${address}%2Ftmp`],
    ["an encoded id character", address.replace("id=0", "id=%30")],
    ["space", `${address} `],
    ["a newline in the id", address.replace("id=0", "id=\n0")],
    ["a trailing newline", `${address}\n`],
    ["a NUL", `${address}\0`],
    ["upper-case scheme", address.replace("deus", "DEUS")],
    ["upper-case host", address.replace("workspace", "Workspace")],
    ["upper-case id parameter", address.replace("?id=", "?ID=")],
    ["upper-case session parameter", `${address}&SESSION=${sessionId}`],
    ["reversed fields", `deus://workspace?session=${sessionId}&id=${workspaceId}`],
    ["10,000 characters", address.padEnd(10_000, "a")],
  ])("refuses %s", (_description, text) => {
    expect(parseWorkspaceLink(text)).toBeNull();
  });

  it.each([
    ["a non-hex digit", workspaceId.replace("a", "g")],
    ["a short id", workspaceId.slice(1)],
    ["a long id", workspaceId + "0"],
    ["misplaced hyphens", workspaceId.replace("1-16", "-116")],
    ["braces", `{${workspaceId}}`],
    ["a UUID URN", `urn:uuid:${workspaceId}`],
    ["a final newline", workspaceId + "\n"],
  ])("refuses %s in either id", (_description, id) => {
    expect(isWorkspaceLinkId(id)).toBe(false);
    expect(parseWorkspaceLink(`deus://workspace?id=${id}`)).toBeNull();
    expect(parseWorkspaceLink(`${address}&session=${id}`)).toBeNull();
  });

  it("refuses non-string search values", () => {
    for (const value of [undefined, null, 42, [sessionId]])
      expect(isWorkspaceLinkId(value)).toBe(false);
  });

  it("never turns text inside an id into another parameter", () => {
    expect(
      parseWorkspaceLink(workspaceLink({ workspaceId: `${workspaceId}&session=${sessionId}` }))
    ).toBeNull();
  });
});
