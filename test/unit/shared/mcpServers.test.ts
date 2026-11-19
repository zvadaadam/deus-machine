import { describe, expect, it } from "vitest";
import { appServerName, toolCardName } from "@shared/mcp-servers";

describe("appServerName", () => {
  it("prefixes every app on Codex, so a person's own server of the app's name never clashes", () => {
    expect(appServerName("context7", "codex-app-server")).toBe("deus_context7");
    expect(appServerName("deus", "codex-app-server")).toBe("deus_deus");
    expect(appServerName("my.app", "codex-app-server")).toBe("deus_my_app");
  });

  it("keeps the app's id on Claude, apart from the names Claude keeps for itself", () => {
    expect(appServerName("context7", "claude-code")).toBe("context7");
    expect(appServerName("deus", "claude-code")).toBe("deus");
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

  it("is the qualified name for another server's tool", () => {
    expect(toolCardName({ toolName: "docs.Edit", mcp: { server: "docs", tool: "Edit" } })).toBe(
      "docs.Edit"
    );
  });

  it("is the harness's name for a tool that is no MCP tool", () => {
    expect(toolCardName({ toolName: "Edit" })).toBe("Edit");
  });
});
