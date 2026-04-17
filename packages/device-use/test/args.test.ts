import { describe, expect, test } from "bun:test";
import { finalizeArgsForCommand, parseArgs } from "../src/cli/args.js";

function run(cli: string[]) {
  return parseArgs(["bun", "device-use", ...cli]);
}

describe("parseArgs", () => {
  test("parses command + positionals", () => {
    const parsed = run(["boot", "iPhone 17"]);
    expect(parsed.command).toBe("boot");
    expect(parsed.positionals).toEqual(["iPhone 17"]);
  });

  test("promotes global flags when they precede the command", () => {
    const parsed = run(["--verbose", "list"]);
    expect(parsed.command).toBe("list");
    expect(parsed.globalFlags.verbose).toBe(true);
  });

  test("--simulator with value", () => {
    const parsed = run(["--simulator", "iPhone 17", "snapshot"]);
    expect(parsed.globalFlags.simulator).toBe("iPhone 17");
    expect(parsed.command).toBe("snapshot");
  });

  test("--timeout converts seconds to ms", () => {
    const parsed = run(["--timeout", "5", "snapshot"]);
    expect(parsed.globalFlags.timeoutMs).toBe(5000);
  });

  test("boolean short flags (-i)", () => {
    const parsed = run(["snapshot", "-i"]);
    expect(parsed.flags["i"]).toBe(true);
  });

  test("--flag=value form", () => {
    const parsed = run(["tap", "--label=Sign In"]);
    expect(parsed.flags["label"]).toBe("Sign In");
  });

  test("finalize re-classifies unclaimed global flags", () => {
    const parsed = run(["tap", "--json", "@e1"]);
    const finalized = finalizeArgsForCommand(parsed, new Set(["id", "label", "x", "y"]));
    expect(finalized.globalFlags.json).toBe(true);
    expect(finalized.flags["json"]).toBeUndefined();
  });
});
