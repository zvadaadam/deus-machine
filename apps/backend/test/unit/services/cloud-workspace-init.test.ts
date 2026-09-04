// httpsOrigin: sandbox clones need https — ssh/scp origins (the default for
// locally-cloned repos) carry no usable credentials in a sandbox.

import { describe, expect, it } from "vitest";
import { githubRepoSlug, httpsOrigin } from "@shared/git-origin";
import { isMintFresh } from "../../../src/services/cloud-workspace-init.service";

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

describe("githubRepoSlug", () => {
  it("accepts real GitHub origins in every form the repo table stores", () => {
    expect(githubRepoSlug("https://github.com/zvadaadam/therapist-backend")).toBe(
      "zvadaadam/therapist-backend"
    );
    expect(githubRepoSlug("https://github.com/zvadaadam/therapist-backend.git")).toBe(
      "zvadaadam/therapist-backend"
    );
    expect(githubRepoSlug("git@github.com:zvadaadam/therapist-backend.git")).toBe(
      "zvadaadam/therapist-backend"
    );
  });

  it("rejects hosts that merely CONTAIN github.com", () => {
    // The old substring regex matched these, so a workspace cloning from an
    // unrelated host would have been handed a GitHub App installation token —
    // git writes it into credentials for THAT host and sends it there.
    expect(githubRepoSlug("https://evil.example/github.com/a/b")).toBeNull();
    expect(githubRepoSlug("https://notgithub.com/x/y")).toBeNull();
    expect(githubRepoSlug("https://github.com.evil.example/a/b")).toBeNull();
    expect(githubRepoSlug("https://gitlab.com/a/b")).toBeNull();
    expect(githubRepoSlug("not a url")).toBeNull();
  });
});

describe("isMintFresh — when a connect may skip the token refresh", () => {
  const now = Date.parse("2026-09-04T10:00:00.000Z");
  const minutes = (n: number) => n * 60_000;

  it("treats a mint younger than fifty minutes as fresh, an older one as stale", () => {
    expect(isMintFresh(now - minutes(10), undefined, now)).toBe(true);
    expect(isMintFresh(now - minutes(49), undefined, now)).toBe(true);
    expect(isMintFresh(now - minutes(51), undefined, now)).toBe(false);
    expect(isMintFresh(now - minutes(13 * 60), undefined, now)).toBe(false);
  });

  it("counts this process's own refresh when the row carries no stamp (named environment, legacy row, known tokenless)", () => {
    expect(isMintFresh(null, undefined, now)).toBe(false);
    expect(isMintFresh(0, undefined, now)).toBe(false);
    expect(isMintFresh(null, now - minutes(5), now)).toBe(true);
    expect(isMintFresh(0, now - minutes(55), now)).toBe(false);
  });
});
