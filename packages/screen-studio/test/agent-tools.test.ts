import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentTools } from "../src/agent-tools.js";
import { tempDir } from "./helpers.js";

const parse = (result: { content: Array<{ text: string }> }) => {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return result.content[0].text;
  }
};

describe("shared agent tools", () => {
  it("run a whole recording the way a host exposes them", async () => {
    const root = tempDir();
    const states: string[] = [];
    let n = 0;
    const agent = createAgentTools(
      {
        resolveSource: async () => "test-pattern:320x240",
        bundleDir: () => join(root, `rec${++n}`),
        resolveRef: async (ref) => (ref === "@e1" ? { x: 10, y: 10, width: 50, height: 20 } : null),
        onStateChange: (state) => states.push(state),
      },
      { defaultMaxSeconds: 30 }
    );
    const call = (name: string, args: Record<string, unknown> = {}) =>
      agent.tools.find((t) => t.name === name)!.handler(args);

    expect(agent.tools.map((t) => t.name)).toEqual([
      "recording_start",
      "recording_chapter",
      "recording_focus",
      "recording_hold",
      "recording_status",
      "recording_stop",
    ]);
    expect(parse(await call("recording_chapter", { title: "Too early" }))).toMatch(
      /recording_start/
    );
    expect(parse(await call("recording_start"))).toMatchObject({ status: "recording" });
    expect(parse(await call("recording_start"))).toMatch(/Already recording/);
    expect(parse(await call("recording_chapter", { title: "Sign in" }))).toMatchObject({
      title: "Sign in",
    });
    expect(parse(await call("recording_focus", { ref: "@e1", label: "Button" }))).toMatchObject({
      rect: { x: 10 },
    });
    expect(parse(await call("recording_focus", { ref: "@e9" }))).toMatch(/Could not find/);
    expect(parse(await call("recording_status"))).toMatchObject({ status: "recording" });
    await new Promise((r) => setTimeout(r, 1500));
    const summary = parse(await call("recording_stop", { preset: "review" }));
    expect(existsSync(summary.outputPath)).toBe(true);
    expect(summary.chapters).toEqual([{ title: "Sign in", time: expect.any(Number) }]);
    expect(states).toEqual(["recording", "stopped"]);
  }, 120_000);
});
