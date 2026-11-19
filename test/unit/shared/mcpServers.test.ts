import { describe, expect, it } from "vitest";
import { appServerName, bareToolName, DEUS_TOOLS_SERVER } from "@shared/mcp-servers";

describe("appServerName", () => {
  it("prefixes every app on Codex, so a person's own server of the app's name never clashes", () => {
    expect(appServerName("context7", "codex-app-server")).toBe("deus_context7");
    expect(appServerName("deus", "codex-app-server")).toBe("deus_deus");
    expect(appServerName("my.app", "codex-app-server")).toBe("deus_my_app");
  });

  it("keeps the app's id on Claude, apart from the names Claude keeps for itself", () => {
    expect(appServerName("context7", "claude-code")).toBe("context7");
    expect(appServerName("deus", "claude-code")).toBe("app_deus");
    expect(appServerName("computer", "claude-code")).toBe("app_computer");
  });
});

describe("bareToolName", () => {
  it("is the same tool whichever harness called Deus's own", () => {
    expect(bareToolName("mcp__deus__BrowserNavigate")).toBe("BrowserNavigate");
    expect(bareToolName(`${DEUS_TOOLS_SERVER}.BrowserNavigate`)).toBe("BrowserNavigate");
  });

  it("leaves built-in tools and other Codex servers' tools as they are", () => {
    expect(bareToolName("Edit")).toBe("Edit");
    expect(bareToolName("deus_context7.resolve-library-id")).toBe(
      "deus_context7.resolve-library-id"
    );
  });
});
