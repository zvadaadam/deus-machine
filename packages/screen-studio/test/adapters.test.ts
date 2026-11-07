import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentDeviceEvents } from "../src/adapters/agent-device.js";
import { cuaTrajectory } from "../src/adapters/cua.js";
import { tempDir } from "./helpers.js";

describe("agent-device telemetry", () => {
  it("becomes actions in media time and iOS points", async () => {
    const path = join(tempDir(), "telemetry.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        events: [
          { kind: "tap", tMs: 3098.4, x: 78, y: 302, referenceWidth: 402, referenceHeight: 874 },
          {
            kind: "swipe",
            tMs: 5000,
            x: 200,
            y: 700,
            toX: 200,
            toY: 200,
            durationMs: 300,
            referenceWidth: 402,
            referenceHeight: 874,
          },
          { kind: "mystery", tMs: 6000 },
          { kind: "tap" },
        ],
      })
    );
    const events = await agentDeviceEvents(path);
    expect(events).toEqual([
      expect.objectContaining({
        type: "tap",
        at: 3098,
        point: { x: 78, y: 302 },
        space: { width: 402, height: 874 },
      }),
      expect.objectContaining({
        type: "swipe",
        at: 5000,
        endAt: 5300,
        path: [
          { x: 200, y: 700 },
          { x: 200, y: 200 },
        ],
      }),
      expect.objectContaining({ type: "other", at: 6000 }),
    ]);
  });
});

describe("Cua trajectory", () => {
  it("becomes actions in media time, without places or typed text", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "session.json"),
      JSON.stringify({ schema_version: 1, video: { path: "recording.mp4", present: true } })
    );
    const turns = [
      {
        tool: "launch_app",
        arguments: { bundle_id: "com.apple.calculator" },
        result_summary: "Launched Calculator (pid 87326) in background.",
        result_error: false,
        t_start_ms_from_session_start: 1185,
        t_ms_from_session_start: 3024,
      },
      {
        tool: "click",
        arguments: { pid: 87326, window_id: 4, element_index: 12 },
        result_summary: 'Clicked AXButton "7".\nwindow state follows',
        result_error: false,
        click_point: { x: 40, y: 300 },
        t_start_ms_from_session_start: 5000,
        t_ms_from_session_start: 5120,
      },
      {
        tool: "type_text",
        arguments: { pid: 87326, text: "hunter2" },
        result_summary: "Typed hunter2",
        result_error: false,
        t_start_ms_from_session_start: 7000,
        t_ms_from_session_start: 7400,
      },
      {
        tool: "click",
        arguments: { pid: 87326, element_index: 99 },
        result_summary: "Refused: element is offscreen",
        result_error: true,
        t_start_ms_from_session_start: 9000,
        t_ms_from_session_start: 9050,
      },
    ];
    turns.forEach((turn, i) => {
      const turnDir = join(dir, `turn-${String(i + 1).padStart(5, "0")}`);
      mkdirSync(turnDir);
      writeFileSync(join(turnDir, "action.json"), JSON.stringify(turn));
    });
    const trajectory = await cuaTrajectory(dir);
    expect(trajectory.videoPath).toBe(join(dir, "recording.mp4"));
    expect(trajectory.skipped).toBe(1);
    expect(trajectory.events).toEqual([
      expect.objectContaining({
        type: "other",
        at: 1185,
        endAt: 3024,
        label: turns[0].result_summary,
      }),
      expect.objectContaining({
        type: "click",
        at: 5000,
        endAt: 5120,
        label: 'Clicked AXButton "7".',
      }),
      expect.objectContaining({ type: "type", at: 7000, label: "type_text [7 chars]" }),
    ]);
    // A window-local click point is not a place on the display.
    expect(trajectory.events[1]).not.toHaveProperty("point");
    expect(JSON.stringify(trajectory.events)).not.toContain("hunter2");
  });
});
