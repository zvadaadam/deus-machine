import { describe, it, expect, vi, beforeEach } from "vitest";

// Simulator tools report their touches so a recording can show them; the
// device itself is mocked.
const { simOps, agentTools } = vi.hoisted(() => ({
  simOps: {
    resolveDevice: vi.fn(async () => "UDID-1"),
    tap: vi.fn(async (_udid: string, opts: { x?: number; y?: number }) => ({
      x: opts.x ?? 50,
      y: opts.y ?? 60,
    })),
    swipe: vi.fn(async () => ({ from: { x: 200, y: 700 }, to: { x: 200, y: 300 } })),
    typeText: vi.fn(async () => {}),
    pressKey: vi.fn(async () => {}),
    screenshot: vi.fn(async () => ({ base64: "", mimeType: "image/jpeg" })),
  },
  agentTools: {
    tools: [],
    current: vi.fn(),
    recordAction: vi.fn(),
  },
}));
vi.mock("../agents/deus-tools/sim-ops", () => simOps);
vi.mock("../../../packages/screen-studio/src/index", () => ({
  createAgentTools: vi.fn(() => agentTools),
}));

import { createSimulatorTools, type SimulatorToolAction } from "../agents/deus-tools/simulator";
import { createRecordingTools, recordSimulatorAction } from "../agents/deus-tools/recording";

async function call(
  tools: ReturnType<typeof createSimulatorTools>,
  name: string,
  args: Record<string, unknown>
) {
  const result = await tools.find((t) => t.name === name)!.handler(args, {});
  return (result.content[0] as { text: string }).text;
}

describe("simulator tools for recording", () => {
  beforeEach(() => vi.clearAllMocks());

  it("report each interaction with where it happened, never typed text", async () => {
    const actions: SimulatorToolAction[] = [];
    const tools = createSimulatorTools("s1", (a) => actions.push(a));
    await call(tools, "SimulatorTap", { x: 120, y: 340, includeScreenshot: false });
    await call(tools, "SimulatorSwipe", { direction: "up" });
    await call(tools, "SimulatorTypeText", { text: "hunter2" });
    await call(tools, "SimulatorPressKey", { key: "return" });

    expect(actions).toEqual([
      expect.objectContaining({
        toolName: "SimulatorTap",
        udid: "UDID-1",
        point: { x: 120, y: 340 },
      }),
      expect.objectContaining({
        toolName: "SimulatorSwipe",
        point: { x: 200, y: 700 },
        path: [
          { x: 200, y: 700 },
          { x: 200, y: 300 },
        ],
      }),
      expect.objectContaining({ toolName: "SimulatorTypeText", label: "[7 chars]" }),
      expect.objectContaining({ toolName: "SimulatorPressKey", label: "return" }),
    ]);
    expect(actions.every((a) => typeof a.startedAt === "number")).toBe(true);
    expect(JSON.stringify(actions)).not.toContain("hunter2");
  });

  it("never fail because recording did", async () => {
    const tools = createSimulatorTools("s1", () => {
      throw new Error("recorder gone");
    });
    const text = await call(tools, "SimulatorTap", { x: 1, y: 2, includeScreenshot: false });
    expect(text).toMatch(/^Tapped/);
  });

  it("land in the session's recording only when it records that simulator", () => {
    createRecordingTools("s1");
    const tap: SimulatorToolAction = {
      toolName: "SimulatorTap",
      udid: "UDID-1",
      startedAt: 1_000,
      point: { x: 120, y: 340 },
    };

    agentTools.current.mockReturnValue(null);
    recordSimulatorAction("s1", tap);
    agentTools.current.mockReturnValue({
      manifest: { source: { kind: "ios-simulator", details: { udid: "UDID-2" } } },
    });
    recordSimulatorAction("s1", tap);
    expect(agentTools.recordAction).not.toHaveBeenCalled();

    agentTools.current.mockReturnValue({
      manifest: { source: { kind: "ios-simulator", details: { udid: "UDID-1" } } },
    });
    recordSimulatorAction("s1", tap);
    recordSimulatorAction("s1", { ...tap, toolName: "SimulatorScreenshot" });
    expect(agentTools.recordAction).toHaveBeenCalledTimes(1);
    expect(agentTools.recordAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tap", at: 1_000, point: { x: 120, y: 340 } })
    );
  });
});
