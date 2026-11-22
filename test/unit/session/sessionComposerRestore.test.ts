import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { CATALOG_MODEL_LISTS, defaultModelId } from "@shared/models";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionComposer } from "@/features/session/ui/SessionComposer";
import type { SessionTurn } from "@shared/types/session";

const state = vi.hoisted(() => ({
  turns: undefined as SessionTurn[] | undefined,
  error: null as Error | null,
  input: vi.fn(),
  actions: vi.fn(() => ({})),
  retry: vi.fn(),
}));
vi.mock("@/features/session/api/session.queries", () => ({
  useSessionWithMessages: () => ({
    session: { id: "session", agent_harness: "codex-app-server" },
    messages: [],
    sessionStatus: "idle",
    loading: false,
    turns: state.turns,
    error: state.error,
    retry: state.retry,
  }),
}));
vi.mock("@/features/workspace/api/workspace.queries", () => ({
  useProjectEnvironment: () => ({ isSuccess: false }),
}));
vi.mock("@/features/settings/api", () => ({ useDefaultThinkingLevel: () => "high" }));
vi.mock("@/features/session/hooks", () => ({ useSessionActions: state.actions }));
vi.mock("@/features/session/ui/MessageInput", () => ({
  MessageInput: (props: unknown) => {
    state.input(props);
    return null;
  },
}));

const client = new QueryClient();
const render = (initialModel?: string) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(SessionComposer, { sessionId: "session", initialModel })
    )
  );
const history: SessionTurn[] = [
  {
    turnId: "turn",
    startedAt: 1,
    execution: { harness: "codex-app-server", model: "gpt-5.6-sol" },
  },
];

beforeEach(() => {
  state.turns = undefined;
  state.error = null;
  client.clear();
  vi.clearAllMocks();
});

describe("composer history restoration", () => {
  it("does not seed a default on failed history, then restores the model when history arrives", () => {
    state.error = new Error("offline");
    expect(render()).toContain("Couldn’t load this conversation.");
    expect(render()).toContain("Try again");
    expect(state.input).not.toHaveBeenCalled();
    state.error = null;
    state.turns = history;
    render();
    expect(state.input).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: expect.objectContaining({
          model: "codex-app-server:gpt-5.6-sol",
          picked: undefined,
        }),
      })
    );
  });

  it("waits for history even before the owning query or direct channel starts loading", () => {
    expect(render()).toContain("Loading conversation…");
    expect(state.input).not.toHaveBeenCalled();
  });

  it("keeps cached history usable after a refresh failure", () => {
    state.turns = history;
    state.error = new Error("refresh failed");
    render();
    expect(state.input).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: expect.objectContaining({
          model: "codex-app-server:gpt-5.6-sol",
          picked: undefined,
        }),
      })
    );
  });

  it("follows the account’s marked Codex default when the live list arrives", () => {
    state.turns = [];
    render();
    const harness = "codex-app-server";
    expect(state.input.mock.lastCall?.[0].selection.model).toBe(
      `${harness}:${defaultModelId(CATALOG_MODEL_LISTS, harness)}`
    );
    client.setQueryData([...queryKeys.settings.agentModels, null], {
      lists: [
        {
          harness,
          source: "live",
          models: ["first", "my-default"].map((id) => ({
            harness,
            id,
            label: id,
            thinking: { levels: ["medium"] },
            isDefault: id === "my-default",
          })),
        },
      ],
    });
    render();
    expect(state.input.mock.lastCall?.[0]).toMatchObject({
      selection: {
        model: "codex-app-server:my-default",
        picked: undefined,
        thinkingLevels: ["medium"],
      },
    });
    expect(state.actions).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "codex-app-server:my-default" })
    );
  });

  it("honors an explicit new-chat choice before history exists", () => {
    render("codex-app-server:gpt-6-astra");
    expect(state.input).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: expect.objectContaining({ model: "codex-app-server:gpt-6-astra" }),
      })
    );
  });
});
