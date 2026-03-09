import { describe, expect, it } from "vitest";
import { isExecError } from "../../../shared/lib/errors";

describe("isExecError", () => {
  it("matches execFile-style async errors", () => {
    const error = Object.assign(new Error("async failed"), {
      killed: false,
      code: 1,
      stderr: "stderr",
      stdout: "stdout",
    });

    expect(isExecError(error)).toBe(true);
  });

  it("matches execFileSync-style errors without killed", () => {
    const error = Object.assign(new Error("sync failed"), {
      status: 128,
      stderr: "file.txt: unmerged\nfatal: git-write-tree: error building trees",
      stdout: "",
      signal: null,
    });

    expect(isExecError(error)).toBe(true);
  });

  it("rejects plain errors without exec metadata", () => {
    expect(isExecError(new Error("plain"))).toBe(false);
  });

  it("rejects malformed exec-like shapes", () => {
    const error = Object.assign(new Error("bad"), {
      status: "128",
    });

    expect(isExecError(error)).toBe(false);
  });
});
