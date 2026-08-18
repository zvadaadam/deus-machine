// httpsOrigin: sandbox clones need https — ssh/scp origins (the default for
// locally-cloned repos) carry no usable credentials in a sandbox.

import { describe, expect, it } from "vitest";
import { httpsOrigin } from "../../../src/services/cloud-workspace-init.service";

describe("httpsOrigin", () => {
  it("converts scp-style ssh origins", () => {
    expect(httpsOrigin("git@github.com:acme/widget.git")).toBe("https://github.com/acme/widget");
    expect(httpsOrigin("git@github.com:acme/widget")).toBe("https://github.com/acme/widget");
  });

  it("converts ssh:// origins", () => {
    expect(httpsOrigin("ssh://git@github.com/acme/widget.git")).toBe(
      "https://github.com/acme/widget"
    );
  });

  it("handles non-github hosts", () => {
    expect(httpsOrigin("git@gitlab.example.com:team/repo.git")).toBe(
      "https://gitlab.example.com/team/repo"
    );
  });

  it("passes https origins through untouched", () => {
    expect(httpsOrigin("https://github.com/acme/widget.git")).toBe(
      "https://github.com/acme/widget.git"
    );
  });
});
