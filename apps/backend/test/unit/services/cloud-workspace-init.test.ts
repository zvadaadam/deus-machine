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

describe("environmentNameForRepo", () => {
  // These vectors are PINNED IDENTICALLY in agnt's environment-update tests —
  // the name is the repo→environment link, derived independently on both
  // sides, so any drift between the two implementations breaks the product.
  it("derives the same identity regardless of .git suffix or trailing slash", async () => {
    const { environmentNameForRepo } =
      await import("../../../src/services/cloud-environment.service");
    const a = await environmentNameForRepo("https://github.com/zvadaadam/deus-machine.git");
    const b = await environmentNameForRepo("https://github.com/zvadaadam/deus-machine");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(a).toContain("deus-machine");
  });

  it("keeps the hash when the slug is truncated at the name limit", async () => {
    const { environmentNameForRepo } =
      await import("../../../src/services/cloud-environment.service");
    const a = await environmentNameForRepo("https://github.com/owner/" + "a".repeat(200));
    const b = await environmentNameForRepo("https://github.com/owner/" + "a".repeat(201));
    expect(a.length).toBeLessThanOrEqual(128);
    expect(a).not.toBe(b);
  });

  it("distinguishes same-name repos under different owners", async () => {
    const { environmentNameForRepo } =
      await import("../../../src/services/cloud-environment.service");
    expect(await environmentNameForRepo("https://github.com/alice/app")).not.toBe(
      await environmentNameForRepo("https://github.com/bob/app")
    );
  });
});
