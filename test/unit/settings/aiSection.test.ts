import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AISection } from "@/features/settings/ui/sections/AISection";
import type { AgentAuthStatus } from "@/features/settings/types";

const state = vi.hoisted(() => ({
  data: undefined as AgentAuthStatus | undefined,
  isError: false,
}));
vi.mock("@/features/settings/api/settings.queries", () => ({
  useAgentAuth: () => ({ ...state, isLoading: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock("@/features/settings/ui/sections/ProviderAccounts", () => ({
  ProviderAccounts: () => null,
}));

beforeEach(() => {
  state.data = undefined;
  state.isError = false;
});

const render = () =>
  renderToStaticMarkup(
    createElement(AISection, {
      settings: {},
      saveSetting: async () => true,
    })
  );

describe("local agent status", () => {
  it.each(["no response", "disconnected runtime", "failed refresh"])(
    "does not claim agents are missing after %s",
    (scenario) => {
      if (scenario === "disconnected runtime")
        state.data = { agents: [], claude: null, codex: null, error: "Agent server not connected" };
      if (scenario === "failed refresh") {
        state.data = { agents: [], claude: null, codex: null };
        state.isError = true;
      }
      const html = render();
      expect(html.match(/Status unavailable/g)).toHaveLength(2);
      expect(html).not.toContain("Not installed");
      expect(html).not.toContain(">Install<");
    }
  );

  it("shows installation actions only when the available runtime reports missing harnesses", () => {
    state.data = { agents: [], claude: null, codex: null };
    const html = render();
    expect(html.match(/Not installed/g)).toHaveLength(2);
    expect(html).not.toContain("Status unavailable");
  });

  it("keeps installed Codex login status owned by its CLI", () => {
    state.data = {
      agents: [{ type: "codex-app-server", installed: true }],
      claude: null,
      codex: null,
    };
    expect(render()).toContain("Login managed by Codex");
  });
});
