import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestProjectTool } = vi.hoisted(() => ({ requestProjectTool: vi.fn() }));
vi.mock("../host-link", () => ({ HostRpc: { requestProjectTool } }));

import { createProjectTools } from "../agents/deus-tools/projects";

describe("Project tool source identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures the exact source turn before an asynchronous relay can observe its successor", async () => {
    let turnId: string | undefined = "turn-original";
    let resolve!: (value: unknown) => void;
    requestProjectTool.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const tools = createProjectTools("session-1", { currentTurnId: () => turnId });
    const report = tools.find((entry) => entry.name === "report_result")!;
    const pending = report.handler({ summary: "Implemented and tested." }, {});

    turnId = "turn-successor";
    resolve({ reportId: "report-1" });
    await expect(pending).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("report-1") }],
    });
    expect(requestProjectTool).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-original",
      toolCallId: expect.any(String),
      operation: "report_result",
      args: { summary: "Implemented and tested." },
    });

    requestProjectTool.mockResolvedValue({ reportId: "report-2" });
    await report.handler({ summary: "A later result." }, {});
    expect(requestProjectTool.mock.calls[1][0].turnId).toBe("turn-successor");
    expect(requestProjectTool.mock.calls[1][0].toolCallId).not.toBe(
      requestProjectTool.mock.calls[0][0].toolCallId
    );
  });

  it("rejects without relaying when the source has no active turn", async () => {
    const tools = createProjectTools("session-1", { currentTurnId: () => undefined });
    for (const entry of tools) {
      await expect(entry.handler({}, {})).resolves.toMatchObject({ isError: true });
    }
    expect(requestProjectTool).not.toHaveBeenCalled();
  });

  it("returns an MCP error when the backend rejects unmanaged or unauthorized access", async () => {
    requestProjectTool.mockRejectedValue(new Error("This session does not belong to a Project."));
    const tools = createProjectTools("ordinary-session", { currentTurnId: () => "turn-1" });
    const status = tools.find((entry) => entry.name === "get_agent_status")!;
    await expect(status.handler({}, {})).resolves.toEqual({
      isError: true,
      content: [
        { type: "text", text: "Project error: This session does not belong to a Project." },
      ],
    });
  });
});
