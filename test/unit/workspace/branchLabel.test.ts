import { describe, expect, it } from "vitest";
import { branchLabel } from "@/features/workspace/lib/branchLabel";

describe("a branch in a branch list", () => {
  it("is origin/<name> when it is a clone's remote-tracking ref", () => {
    expect(branchLabel({ name: "master", is_remote: true })).toEqual({
      prefix: "origin/",
      localOnly: false,
    });
  });

  it("is a plain name for a project with no clone (GitHub's branches)", () => {
    expect(branchLabel({ name: "master" })).toEqual({ prefix: null, localOnly: false });
  });

  it("is marked local when only this computer has it", () => {
    expect(branchLabel({ name: "wip", is_local: true })).toEqual({
      prefix: null,
      localOnly: true,
    });
  });
});
