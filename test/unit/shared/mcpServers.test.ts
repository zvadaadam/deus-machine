import { describe, expect, it } from "vitest";
import { appServerName, toolCardName } from "@shared/mcp-servers";

describe("appServerName", () => {
  it("prefixes every app on Codex, so a person's own server of the app's name never clashes", () => {
    expect(appServerName("context7", "codex-app-server")).toBe("deus_context7");
    expect(appServerName("deus", "codex-app-server")).toBe("deus_deus");
    expect(appServerName("my.app", "codex-app-server")).toBe("deus_my_app");
  });

  it("uses plain app ids on Gemini, including names other harnesses reserve", () => {
    for (const name of ["context7", "deus", "computer"])
      expect(appServerName(name, "gemini")).toBe(name);
  });

  it("keeps the app's id on Claude, apart from the names Claude keeps for itself", () => {
    expect(appServerName("context7", "claude-code")).toBe("context7");
    expect(appServerName("deus", "claude-code")).toBe("app_deus");
    expect(appServerName("computer", "claude-code")).toBe("app_computer");
  });
});

describe("toolCardName", () => {
  it("is an MCP tool's own name, whichever harness called it", () => {
    const mcp = { server: "deus_chat_tools", tool: "BrowserNavigate" };
    expect(toolCardName({ toolName: "mcp__deus_chat_tools__BrowserNavigate", mcp })).toBe(
      "BrowserNavigate"
    );
    expect(toolCardName({ toolName: "deus_chat_tools.BrowserNavigate", mcp })).toBe(
      "BrowserNavigate"
    );
  });

  it("is a Deus tool's own name under the names older builds stored", () => {
    // Claude, server `deus`, with and without `mcp`; Codex without `mcp`.
    expect(
      toolCardName({
        toolName: "mcp__deus__recording_stop",
        mcp: { server: "deus", tool: "recording_stop" },
      })
    ).toBe("recording_stop");
    expect(toolCardName({ toolName: "mcp__deus__recording_stop" })).toBe("recording_stop");
    expect(toolCardName({ toolName: "deus_chat_tools.BrowserScreenshot" })).toBe(
      "BrowserScreenshot"
    );
    // `deus` is Claude's old server only: a person's own Codex server of that name is theirs.
    expect(toolCardName({ toolName: "deus.Edit", mcp: { server: "deus", tool: "Edit" } })).toBe(
      "deus.Edit"
    );
    expect(toolCardName({ toolName: "deus.Edit" })).toBe("deus.Edit");
    // Any other server's tool keeps its qualified name.
    expect(toolCardName({ toolName: "mcp__docs__Edit" })).toBe("mcp__docs__Edit");
    expect(toolCardName({ toolName: "mcp__deusx__Edit" })).toBe("mcp__deusx__Edit");
  });

  it("is the qualified name for another server's tool", () => {
    expect(toolCardName({ toolName: "docs.Edit", mcp: { server: "docs", tool: "Edit" } })).toBe(
      "docs.Edit"
    );
  });

  it("is the harness's name for a tool that is no MCP tool", () => {
    expect(toolCardName({ toolName: "Edit" })).toBe("Edit");
  });
});
