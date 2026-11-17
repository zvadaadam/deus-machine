// What may be cloned (the app's "Clone from GitHub" and an assistant's
// `add_project` alike), the folder a clone goes into, and the words a refused
// address gets: never the address itself.

import { describe, expect, it } from "vitest";
import { CLONE_REFUSALS, parseCloneAddress } from "../../../src/lib/clone-address";

const accepted = (input: string) => {
  const parsed = parseCloneAddress(input);
  if (!parsed.ok) throw new Error(`refused ${input}: ${parsed.reason}`);
  return parsed.address;
};
const reason = (input: string) => {
  const parsed = parseCloneAddress(input);
  if (parsed.ok) throw new Error(`accepted ${input}`);
  return parsed.reason;
};

describe("an address that is accepted", () => {
  it.each([
    ["acme/widget", "https://github.com/acme/widget", "widget"],
    ["acme/widget.git", "https://github.com/acme/widget", "widget"],
    ["https://github.com/acme/widget", "https://github.com/acme/widget", "widget"],
    ["https://github.com/acme/widget.git/", "https://github.com/acme/widget.git", "widget"],
    ["https://gitlab.example.com:8443/group/sub/tool", null, "tool"],
    ["git@github.com:acme/widget.git", "git@github.com:acme/widget.git", "widget"],
    ["ssh://git@github.com/acme/widget.git", "ssh://git@github.com/acme/widget.git", "widget"],
    ["ssh://git.example.com:2222/acme/widget", null, "widget"],
    ["acme/.github", "https://github.com/acme/.github", "github"],
  ])("%s", (input, url, name) => {
    const address = accepted(input);
    expect(address.url).toBe(url ?? input);
    expect(address.name).toBe(name);
  });

  it("is one repository however it is written", () => {
    const keys = [
      "acme/widget",
      "https://github.com/Acme/widget.git",
      "git@github.com:acme/widget.git",
      "ssh://git@github.com/acme/widget",
    ].map((input) => accepted(input).key);
    expect(new Set(keys).size).toBe(1);
  });
});

describe("an address that is refused", () => {
  it.each([
    ["", CLONE_REFUSALS.empty],
    ["x".repeat(501), CLONE_REFUSALS.tooLong],
    ["acme/widget ", CLONE_REFUSALS.characters],
    ["https://github.com/acme/wid get", CLONE_REFUSALS.characters],
    ["https://github.com/acme/widget\n", CLONE_REFUSALS.characters],
    ["https://github.com/acme/\u0007widget", CLONE_REFUSALS.characters],
    ["https://github.com/acme/wïdget", CLONE_REFUSALS.characters],
    ["https://github.com/acme/‮widget", CLONE_REFUSALS.characters],
    ["-uhttps://github.com/acme/widget", CLONE_REFUSALS.dash],
    ["--upload-pack=touch", CLONE_REFUSALS.dash],
    ["http://github.com/acme/widget", CLONE_REFUSALS.http],
    ["/Users/someone/widget", CLONE_REFUSALS.form],
    ["./widget", CLONE_REFUSALS.form],
    ["~/widget", CLONE_REFUSALS.form],
    ["../widget", CLONE_REFUSALS.form],
    ["file:///Users/someone/widget", CLONE_REFUSALS.form],
    ["file://localhost/etc", CLONE_REFUSALS.form],
    ["ext::sh%20-c%20touch", CLONE_REFUSALS.form],
    ["fd::3", CLONE_REFUSALS.form],
    ["git://github.com/acme/widget", CLONE_REFUSALS.form],
    ["github.com:acme/widget", CLONE_REFUSALS.form],
    ["git@-oProxyCommand=touch:acme/widget", CLONE_REFUSALS.form],
    ["ssh://-oProxyCommand=touch/acme/widget", CLONE_REFUSALS.form],
    ["git@github.com:-acme/widget", CLONE_REFUSALS.form],
    ["https://github.com/acme/widget?x=1", CLONE_REFUSALS.form],
    ["https://github.com/acme/widget#main", CLONE_REFUSALS.form],
    ["https://github.com/acme/%2e%2e", CLONE_REFUSALS.form],
    ["https://github.com", CLONE_REFUSALS.form],
    ["acme/..", CLONE_REFUSALS.name],
    ["https://github.com/acme/..", CLONE_REFUSALS.name],
    ["https://github.com/acme/widget/../..", CLONE_REFUSALS.name],
    ["acme/.git", CLONE_REFUSALS.name],
    ["acme/...", CLONE_REFUSALS.name],
  ])("%j", (input, why) => {
    expect(reason(input)).toBe(why);
  });

  it.each([
    "https://someone:ghp_SECRETtoken@github.com/acme/widget",
    "https://ghp_SECRETtoken@github.com/acme/widget",
    "https://x-access-token:ghp_SECRETtoken@github.com/acme/widget.git",
    "http://someone:ghp_SECRETtoken@github.com/acme/widget",
    "ssh://git:ghp_SECRETtoken@github.com/acme/widget",
  ])("with a credential in it, in words that do not repeat it: %s", (input) => {
    const why = reason(input);
    expect(why).toBe(CLONE_REFUSALS.credential);
    expect(why).not.toContain("SECRET");
  });
});
