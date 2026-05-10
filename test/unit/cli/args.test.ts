import { describe, expect, it } from "vitest";
import {
  getCliCommand,
  getCliCommandIndex,
  isGlobalVersionRequest,
} from "../../../apps/cli/src/args";

describe("CLI argument helpers", () => {
  it("treats top-level version flags as global version requests", () => {
    expect(isGlobalVersionRequest(["--version"])).toBe(true);
    expect(isGlobalVersionRequest(["-v"])).toBe(true);
  });

  it("leaves command-specific --version flags for the command parser", () => {
    expect(getCliCommand(["install", "--version", "v0.3.6"])).toBe("install");
    expect(isGlobalVersionRequest(["install", "--version", "v0.3.6"])).toBe(false);
  });

  it("finds explicit commands after leading global flags", () => {
    const args = ["--no-color", "install", "--version", "v0.3.6"];

    expect(getCliCommandIndex(args)).toBe(1);
    expect(getCliCommand(args)).toBe("install");
    expect(isGlobalVersionRequest(args)).toBe(false);
  });
});
