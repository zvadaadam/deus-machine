import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionComposer } from "@/features/session/ui/SessionComposer";
import type { SessionTurn } from "@shared/types/session";

const state = vi.hoisted(() => ({
  turns: undefined as SessionTurn[] | undefined,
  error: null as Error | null,
  input: vi.fn(),
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
vi.mock("@/features/settings/api", () => ({ useSettings: () => ({ data: {} }) }));
vi.mock("@/features/session/hooks", () => ({ useSessionActions: () => ({}) }));
vi.mock("@/features/session/ui/MessageInput", () => ({
  MessageInput: (props: { initialModel: string }) => {
    state.input(props);
    return null;
  },
}));

const render = (initialModel?: string) =>
  renderToStaticMarkup(createElement(SessionComposer, { sessionId: "session", initialModel }));
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
  vi.clearAllMocks();
});

describe("composer history restoration", () => {
  it("does not seed a default on failed history, then restores the recorded model after retry", () => {
    state.error = new Error("offline");
    expect(render()).toContain("Couldn’t load this conversation.");
    expect(render()).toContain("Try again");
    expect(state.input).not.toHaveBeenCalled();
    state.error = null;
    state.turns = history;
    render();
    expect(state.input).toHaveBeenCalledWith(
      expect.objectContaining({ initialModel: "codex-app-server:gpt-5.6-sol" })
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
      expect.objectContaining({ initialModel: "codex-app-server:gpt-5.6-sol" })
    );
  });

  it("honors an explicit new-chat choice before history exists", () => {
    render("codex-app-server:gpt-6-astra");
    expect(state.input).toHaveBeenCalledWith(
      expect.objectContaining({ initialModel: "codex-app-server:gpt-6-astra" })
    );
  });
});
