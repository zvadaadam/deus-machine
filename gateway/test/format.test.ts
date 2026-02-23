import { describe, it, expect } from "vitest";
import { extractText, truncate, formatWorkspaceList, formatSessionStatus, formatDiffStats } from "../lib/format";

describe("extractText", () => {
  it("returns empty string for null/undefined", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
  });

  it("extracts text from assistant message content blocks", () => {
    const data = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello, I found the bug!" },
        ],
      },
    };
    expect(extractText(data)).toBe("Hello, I found the bug!");
  });

  it("extracts text from multiple content blocks", () => {
    const data = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "First part." },
          { type: "tool_use", name: "Edit" },
          { type: "text", text: "Second part." },
        ],
      },
    };
    expect(extractText(data)).toBe("First part.\n[Using Edit...]\nSecond part.");
  });

  it("extracts streaming text deltas", () => {
    const data = { type: "text", text: "partial text..." };
    expect(extractText(data)).toBe("partial text...");
  });

  it("handles result events", () => {
    expect(extractText({ type: "result" })).toBe("");
    expect(extractText({ type: "result", subtype: "error_max_turns" })).toBe(
      "[Agent reached max turns]"
    );
  });

  it("returns empty for unknown event types", () => {
    expect(extractText({ type: "unknown" })).toBe("");
  });
});

describe("truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("hello")).toBe("hello");
  });

  it("truncates long text with indicator", () => {
    const long = "x".repeat(5000);
    const result = truncate(long, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain("... [truncated]");
  });

  it("respects custom max length", () => {
    const result = truncate("a".repeat(200), 50);
    expect(result.length).toBeLessThanOrEqual(50);
  });
});

describe("formatWorkspaceList", () => {
  it("formats repos and workspaces", () => {
    const repos = [
      {
        repo_name: "my-app",
        workspaces: [
          { id: "w1", name: "happy-cat", state: "active" },
          { id: "w2", name: "sleepy-dog", state: "idle" },
        ],
      },
    ];
    const result = formatWorkspaceList(repos);
    expect(result).toContain("*my-app*");
    expect(result).toContain("+ happy-cat (active)");
    expect(result).toContain("- sleepy-dog (idle)");
  });

  it("handles empty repos", () => {
    expect(formatWorkspaceList([])).toContain("No repos found");
  });

  it("handles repos with no workspaces", () => {
    const repos = [{ repo_name: "empty-repo", workspaces: [] }];
    expect(formatWorkspaceList(repos)).toContain("(no workspaces)");
  });
});

describe("formatSessionStatus", () => {
  it("formats session status", () => {
    const result = formatSessionStatus({
      id: "sess-1",
      status: "working",
      title: "Fix login",
      agent_type: "claude",
    });
    expect(result).toContain("Status: working");
    expect(result).toContain("Title: Fix login");
    expect(result).toContain("Agent: claude");
  });

  it("omits missing fields", () => {
    const result = formatSessionStatus({
      id: "sess-1",
      status: "idle",
    });
    expect(result).toBe("Status: idle");
    expect(result).not.toContain("Title:");
  });
});

describe("formatDiffStats", () => {
  it("formats diff statistics", () => {
    const result = formatDiffStats({ additions: 42, deletions: 7, files_changed: 5 });
    expect(result).toContain("Files changed: 5");
    expect(result).toContain("+42 / -7");
  });
});
