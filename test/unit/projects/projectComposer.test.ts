import { createElement, createRef, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectComposer } from "@/features/projects/ui/ProjectComposer";
import type { SessionComposerRef } from "@/features/session/ui/SessionComposer";
import {
  sessionComposerActions as composer,
  useSessionComposerStore as store,
} from "@/features/session/store/sessionComposerStore";

const state = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  post: vi.fn(),
  action: vi.fn(),
  project: {
    id: "project",
    model: "claude-sonnet-4-6",
    status: "idle",
    paused: false,
    agents: [{ id: "agent", role: "coordinator", status: "idle", paused: false }],
  },
}));

// Keep the component and shared draft store real; flush mount effects explicitly
// because these frontend tests use React's server renderer without a DOM.
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useEffect: (effect: EffectCallback) => state.effects.push(effect),
    useLayoutEffect: react.useEffect,
    useImperativeHandle: (ref: { current: unknown } | null, create: () => unknown) => {
      if (ref) ref.current = create();
    },
  };
});
vi.mock("@/features/session/store/sessionComposerStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/session/store/sessionComposerStore")>();
  return {
    ...actual,
    useSessionComposerStore: Object.assign(
      (selector: (value: ReturnType<typeof actual.useSessionComposerStore.getState>) => unknown) =>
        selector(actual.useSessionComposerStore.getState()),
      actual.useSessionComposerStore
    ),
  };
});
vi.mock("@/features/projects/api/projects.queries", () => ({
  useProject: () => ({ data: state.project }),
  useProjectAction: () => ({ isPending: false, mutateAsync: state.action }),
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: { mutationFn: (input: unknown) => unknown }) => ({
    mutateAsync: options.mutationFn,
    isPending: false,
  }),
}));
vi.mock("@/shared/api/client", () => ({ apiClient: { post: state.post } }));
vi.mock("@/shared/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/assets/agents", () => ({ getAgentLogo: () => undefined }));
vi.mock("@/features/projects/ui/ProjectMessageQueue", () => ({ ProjectMessageQueue: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  store.setState({ composers: {}, pendingContent: {} });
  state.effects = [];
  state.post.mockReset().mockResolvedValue({ inputId: "input" });
  state.action.mockReset().mockResolvedValue({});
  state.project.status = "idle";
  state.project.paused = false;
  state.project.agents[0].status = "idle";
  state.project.agents[0].paused = false;
});

function render(props: { current?: boolean; onSendComplete?: () => void } = {}) {
  const ref = createRef<SessionComposerRef>();
  const html = renderToStaticMarkup(
    createElement(ProjectComposer, {
      projectId: "project",
      agentId: "agent",
      sessionId: "session",
      current: true,
      ...props,
      ref,
    })
  );
  state.effects.splice(0).forEach((effect) => effect());
  return { html, actions: ref.current! };
}

describe("managed Project composer", () => {
  it("shows the fixed project model without a model-switch control", () => {
    const { html } = render();
    expect(html).toContain('aria-label="Fixed model: Sonnet 4.6"');
    expect(html).not.toContain("Select model");
    expect(html).not.toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-label="Message coordinator"');
  });

  it("shows review text staged before mount and keeps subsequent cross-panel comments", () => {
    composer.appendDraft("session", "Review these changes");
    render();
    expect(render().html).toContain("Review these changes");
    expect(store.getState().pendingContent).toEqual({});
    composer.appendDraft("session", "Check this diff comment");
    expect(render().html).toContain("Review these changes\n\nCheck this diff comment");
    expect(store.getState().composers.session.model).toBe("claude-code:claude-sonnet-4-6");
  });

  it("keeps a failed queued send available, then clears and notifies only on success", async () => {
    composer.appendDraft("session", "Review these changes");
    render();
    const onSendComplete = vi.fn();
    const { actions } = render({ onSendComplete });
    state.post.mockRejectedValueOnce(new Error("Offline"));
    expect(await actions.sendMessage("Review these changes")).toBe(false);
    expect(store.getState().composers.session.draft).toBe("Review these changes");
    expect(onSendComplete).not.toHaveBeenCalled();
    expect(await actions.sendMessage("Review these changes")).toBe(true);
    expect(onSendComplete).toHaveBeenCalledOnce();
    expect(store.getState().composers.session.draft).toBe("");
    expect(state.post.mock.calls[0]).toEqual(state.post.mock.calls[1]);
  });

  it("keeps a historical conversation read-only", async () => {
    const { html, actions } = render({ current: false });
    expect(html).toContain("retained as project history");
    expect(html).not.toContain("textarea");
    expect(await actions.sendMessage("Continue")).toBe(false);
    expect(state.post).not.toHaveBeenCalled();
  });

  it("queues a follow-up while the agent works and keeps Stop available", async () => {
    state.project.agents[0].status = "working";
    const { html, actions } = render();
    expect(html).toContain("Your message runs after this turn");
    expect(html).toContain('aria-label="Stop execution"');
    expect(await actions.sendMessage("Focus on the report")).toBe(true);
    expect(state.post).toHaveBeenCalledWith("/projects/project/message", {
      message: "Focus on the report",
      agentId: "agent",
      requestId: expect.any(String),
    });
    await actions.stopSession();
    expect(state.action).toHaveBeenCalledWith({
      action: "stop",
      agentId: "agent",
      requestId: expect.any(String),
    });
  });

  it("preserves paused-project queueing and archived read-only behavior", async () => {
    state.project.paused = true;
    const paused = render();
    expect(paused.html).toContain("Queued until resumed");
    expect(await paused.actions.sendMessage("Next direction")).toBe(true);

    state.project.status = "archived";
    const archived = render();
    expect(archived.html).not.toContain("textarea");
    expect(await archived.actions.sendMessage("Continue")).toBe(false);
    expect(state.post).toHaveBeenCalledOnce();
  });
});
