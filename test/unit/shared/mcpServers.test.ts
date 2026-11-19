import { describe, expect, it } from "vitest";
import { appServerName } from "@shared/mcp-servers";

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
