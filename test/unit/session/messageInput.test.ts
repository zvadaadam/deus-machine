import { createElement, type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api } from "@shared/api";
import * as platform from "@/platform/capabilities";
import * as ws from "@/platform/ws";
import { useChatModel } from "@/shared/hooks/useModelLists";
import { queryKeys } from "@/shared/api/queryKeys";
import { SessionComposer } from "@/features/session/ui/SessionComposer";
import type { ModelPicker } from "@/features/session/ui/model-picker/ModelPicker";
import { MessageInput } from "@/features/session/ui/MessageInput";
import {
  composerStore,
  emptyComposer,
  sessionComposerActions,
} from "@/features/session/store/sessionComposerStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionStatus } from "@shared/enums";

// Render the actual composer and toolbar; unrelated provider pickers don't
// need a live settings connection to verify whether a user can stop a turn.
vi.mock("@/features/session/ui/model-picker/ModelPicker", () => ({ ModelPicker: controls.picker }));
const controls = vi.hoisted(() => ({
  picker: vi.fn((_props: ComponentProps<typeof ModelPicker>) => null),
  input: vi.fn(),
  button: vi.fn(),
  mobile: vi.fn(() => false),
  subscribe: vi.fn(),
}));
vi.mock("@/shared/hooks/useQuerySubscription", () => ({
  useQuerySubscription: controls.subscribe,
}));
vi.mock("@/shared/hooks/use-mobile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/hooks/use-mobile")>()),
  useIsMobile: controls.mobile,
}));
vi.mock("@/components/ui/input-group", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/input-group")>();
  return {
    ...actual,
    InputGroupTextarea: (props: ComponentProps<typeof actual.InputGroupTextarea>) => {
      controls.input(props);
      return createElement(actual.InputGroupTextarea, props);
    },
  };
});
vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  return {
    ...actual,
    Button: (props: ComponentProps<typeof actual.Button>) => {
      controls.button(props);
      return createElement(actual.Button, props);
    },
  };
});
// A cloud chat's `/` menu reads Customize's live state: none unless a test sets some.
const cloudSkills = vi.hoisted(() => ({
  items: [] as { name: string; description: string; kind: "skill" }[],
}));
vi.mock("@/features/session/hooks/useCloudSlashItems", () => ({
  useCloudSlashItems: () => cloudSkills.items,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useLayoutEffect: react.useEffect };
});

function Input({
  initialModel,
  ...props
}: Omit<ComponentProps<typeof MessageInput>, "selection"> & { initialModel?: string }) {
  const selection = useChatModel({ cloud: props.workspaceKind === "cloud", picked: initialModel });
  return createElement(MessageInput, { ...props, selection });
}

const client = new QueryClient();
afterEach(() => client.clear());
function render(element: ReactElement) {
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null, element))
  );
}
function renderInput(props: Partial<ComponentProps<typeof Input>>) {
  return render(
    createElement(Input, {
      sessionId: "test",
      sending: false,
      sessionStatus: "idle",
      onStop: vi.fn(),
      onSend: vi.fn(),
      ...props,
    })
  );
}

it("keeps a draft while there is no model, explains Send and enables it when a list arrives", () => {
  const error = "The fixture CLI is signed out.";
  const key = [...queryKeys.settings.agentModels, null];
  client.setQueryData(key, {
    lists: [{ harness: "claude-code", source: "catalog", models: [], error }],
  });
  const sessionId = "waiting-draft";
  const store = composerStore();
  sessionComposerActions.seedIfAbsent(sessionId, emptyComposer(undefined, "high"));
  sessionComposerActions.setDraft(sessionId, "Keep my draft");
  // Render the current store snapshot as the browser would.
  const snapshot = vi.spyOn(store, "getInitialState").mockImplementation(store.getState);
  try {
    const html = renderInput({ sessionId });
    const sendButton = /<button[^>]*aria-label="Send message"[^>]*>/;
    expect(html).toContain(`>${error}</p>`);
    expect(html.match(sendButton)?.[0]).toContain(' disabled=""');
    expect(html.match(sendButton)?.[0]).toContain(`title="${error}"`);
    expect(html.match(/<textarea[^>]*>/)?.[0]).not.toContain(' disabled=""');
    expect(html).toContain("Keep my draft</textarea>");
    const pending = "You can send this draft when the chat opens.";
    const waiting = renderInput({ sessionId, sendDisabledReason: pending });
    expect(waiting).toContain(`>${pending}</p>`);
    expect(waiting.match(sendButton)?.[0]).toContain(`title="${pending}"`);
    client.setQueryData(key, {
      lists: [
        {
          harness: "claude-code",
          source: "live",
          models: [
            { id: "returned", harness: "claude-code", label: "Returned", thinking: { levels: [] } },
          ],
        },
      ],
    });
    const ready = renderInput({ sessionId });
    expect(ready.match(sendButton)?.[0]).not.toContain(' disabled=""');
    expect(ready).toContain("Keep my draft</textarea>");
  } finally {
    snapshot.mockRestore();
    sessionComposerActions.discard(sessionId);
  }
});

it.each(["catalog", "live"] as const)(
  "keeps the requested level until a native choice has live data (%s)",
  (source) => {
    const sessionId = "model-choice-" + source;
    const harness = "claude-code";
    const thinking = { levels: ["low", "high"] };
    client.setQueryData([...queryKeys.settings.agentModels, null], {
      lists: [{ harness, source, models: [{ harness, id: "next", label: "Next", thinking }] }],
    });
    sessionComposerActions.seedIfAbsent(sessionId, emptyComposer("claude-code:opus", "max"));
    try {
      renderInput({ sessionId });
      const choice = controls.picker.mock.lastCall![0];
      choice.onModelChange!(
        { value: "claude-code:next", id: "next", label: "Next", agentHarness: harness, thinking },
        "high"
      );
      expect(composerStore().getState().composers[sessionId]).toMatchObject({
        model: "claude-code:next",
        thinkingLevel: source === "live" ? "high" : "max",
      });
    } finally {
      sessionComposerActions.discard(sessionId);
    }
  }
);

it("opens a chat from another build with its draft editable and Send disabled", () => {
  const id = "unknown-agent-session";
  const harness = "future-agent";
  client.setQueryData(queryKeys.sessions.detail(id), {
    id,
    workspace_kind: "worktree",
    agent_harness: harness,
    status: "idle",
  });
  client.setQueryData(queryKeys.sessions.messages(id), {
    messages: [{ id: "earlier", role: "user" }],
    compactions: [],
    turns: [{ turnId: "t", execution: { harness, model: "recorded-model" } }],
    has_older: false,
    has_newer: false,
  });
  const store = composerStore();
  sessionComposerActions.seedIfAbsent(id, emptyComposer(undefined, "high"));
  sessionComposerActions.setDraft(id, "Keep this draft");
  const snapshot = vi.spyOn(store, "getInitialState").mockImplementation(store.getState);
  try {
    for (const initialModel of [undefined, "claude-code:opus"]) {
      const html = render(createElement(SessionComposer, { sessionId: id, initialModel }));
      expect(html).toContain("future-agent");
      expect(html).toContain("is not one this version of Deus runs.");
      expect(html.match(/<button[^>]*aria-label="Send message"[^>]*>/)?.[0]).toContain(
        ' disabled=""'
      );
      expect(html.match(/<textarea[^>]*>/)?.[0]).not.toContain(' disabled=""');
      expect(html).toContain("Keep this draft</textarea>");
      expect(html).not.toContain('aria-label="Plan mode"');
    }
  } finally {
    snapshot.mockRestore();
    sessionComposerActions.discard(id);
  }
});

describe("composer Stop availability", () => {
  it.each([
    ["working", true],
    ["needs_response", true],
    ["needs_plan_response", true],
    ["idle", false],
    ["error", false],
  ] satisfies [SessionStatus, boolean][])("%s shows Stop: %s", (sessionStatus, canStop) => {
    expect(renderInput({ sessionStatus }).includes('title="Stop execution"')).toBe(canStop);
  });
});

describe("sending from the composer", () => {
  const store = composerStore();
  const row = { id: "row", text: "Follow up with details", images: 0, state: "waiting" } as const;
  const button = (label: string) =>
    controls.button.mock.calls.findLast(([props]) => props["aria-label"] === label)![0];
  beforeEach(() => {
    client.setQueryData(queryKeys.sessions.queued("test"), { items: [row], paused: null });
    sessionComposerActions.seedIfAbsent("test", emptyComposer("claude-code:opus", "high"));
    sessionComposerActions.setDraft("test", "Follow up");
    vi.spyOn(store, "getInitialState").mockImplementation(store.getState);
  });
  afterEach(() => {
    sessionComposerActions.discard("test");
    vi.restoreAllMocks();
  });

  it.each([
    ["worktree", "working", "Queue message", "steer"],
    ["worktree", "needs_response", "Queue message", "send"],
    ["worktree", "needs_plan_response", "Queue message", "send"],
    ["worktree", "idle", "Send message", "send"],
    ["worktree", "error", "Send message", "send"],
    ["cloud", "working", "Send message", "native"],
    ["cloud", "idle", "Send message", "native"],
    ["worktree", undefined, "Send message", "native"],
  ] as const)(
    "Enter and modified Enter in %s (%s)",
    (workspaceKind, sessionStatus, label, chord) => {
      for (const mac of [true, false]) {
        vi.spyOn(platform, "isMac", "get").mockReturnValue(mac);
        const send = vi.fn(() => false);
        controls.subscribe.mockClear();
        const html = renderInput({ workspaceKind, sessionStatus, onSend: send });
        expect(controls.subscribe.mock.calls.some(([op]) => op === api.queuedMessages)).toBe(
          chord !== "native"
        );
        expect(html).toContain(`aria-label="${label}"`);
        const shortcut = mac ? "⌘Enter" : "Ctrl+Enter";
        const steerHint = chord === "steer" ? ` · Steer (${shortcut})` : "";
        expect(html).toContain(`title="${label} (Enter)${steerHint}"`);

        const key = controls.input.mock.lastCall![0].onKeyDown;
        const enter = { key: "Enter", nativeEvent: {}, preventDefault: vi.fn() };
        const modified = { ...enter, metaKey: mac, ctrlKey: !mac, preventDefault: vi.fn() };
        key(enter);
        key(modified);
        key({ ...enter, shiftKey: true });
        key({ ...enter, metaKey: !mac, ctrlKey: mac });
        key({ ...enter, metaKey: mac, ctrlKey: !mac, altKey: true });
        key({ ...enter, nativeEvent: { isComposing: true } });
        const calls = [["Follow up", undefined]];
        if (chord !== "native") calls.push(["Follow up", chord === "steer" ? "steer" : undefined]);
        expect(send.mock.calls).toEqual(calls);
        expect(enter.preventDefault).toHaveBeenCalledOnce();
        expect(modified.preventDefault).toHaveBeenCalledTimes(chord === "native" ? 0 : 1);
      }
    }
  );

  it("keeps Edit disabled until a pending send clears its draft", async () => {
    const call = vi
      .spyOn(ws, "call")
      .mockResolvedValueOnce({ content: row.text })
      .mockResolvedValueOnce({ removed: true });
    const reply = Promise.withResolvers<boolean>();
    const send = new MutationObserver<boolean, Error, string>(client, {
      mutationFn: () => reply.promise,
    });
    const render = () =>
      renderInput({
        workspaceKind: "worktree",
        sessionStatus: "working",
        sending: send.getCurrentResult().isPending,
        onSend: (content) => send.mutate(content),
      });

    render();
    button("Queue message").onClick();
    expect(send.getCurrentResult().variables).toBe("Follow up");
    const editButton = /<button[^>]*aria-label="Edit queued message"[^>]*>/;
    expect(render().match(editButton)?.[0]).toContain('disabled=""');
    expect(call).not.toHaveBeenCalled();
    expect(store.getState().composers.test.draft).toBe("Follow up");

    reply.resolve(true);
    await vi.waitFor(() => expect(store.getState().composers.test.draft).toBe(""));
    expect(render().match(editButton)?.[0]).not.toContain('disabled=""');
    await button("Edit queued message").onClick();
    expect(call.mock.calls).toEqual([
      [api.queuedMessage, { sessionId: "test", id: row.id }],
      [api.removeQueuedMessage, { sessionId: "test", id: row.id }],
    ]);
    expect(store.getState().composers.test.draft).toBe(row.text);
  });

  it("holds Send through the Edit read, draft restoration and remove reply", async () => {
    const read = Promise.withResolvers<{ content: string }>();
    const remove = Promise.withResolvers<{ removed: boolean }>();
    const call = vi
      .spyOn(ws, "call")
      .mockReturnValueOnce(read.promise)
      .mockReturnValueOnce(remove.promise);
    const send = vi.fn(() => true);
    const draw = () =>
      renderInput({ workspaceKind: "worktree", sessionStatus: "working", onSend: send });
    const trySend = () => {
      draw();
      expect(button("Queue message").disabled).toBe(true);
      button("Queue message").onClick();
      controls.input.mock.lastCall![0].onKeyDown({
        key: "Enter",
        nativeEvent: {},
        preventDefault: vi.fn(),
      });
      expect(send).not.toHaveBeenCalled();
    };
    draw();
    const edit = button("Edit queued message").onClick();
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledExactlyOnceWith(api.queuedMessage, {
        sessionId: "test",
        id: row.id,
      })
    );
    trySend();
    expect(store.getState().composers.test.draft).toBe("Follow up");
    read.resolve({ content: row.text });
    await vi.waitFor(() =>
      expect(call).toHaveBeenNthCalledWith(2, api.removeQueuedMessage, {
        sessionId: "test",
        id: row.id,
      })
    );
    trySend();
    remove.resolve({ removed: true });
    await edit;
    draw();
    expect(button("Queue message").disabled).toBe(false);
    expect(store.getState().composers.test.draft).toBe("Follow up with details\n\nFollow up");
  });

  it.each([
    ["Enter", false, api.sendMessage],
    ["Command-Enter", true, api.steerMessage],
  ] as const)(
    "keeps the draft and shows the host's refusal for a full queue on %s",
    async (_key, metaKey, op) => {
      client.setQueryData(queryKeys.sessions.queued("test"), {
        items: Array.from({ length: 20 }, (_, index) => ({ ...row, id: String(index) })),
        paused: null,
      });
      client.setQueryData(queryKeys.sessions.detail("test"), {
        id: "test",
        workspace_kind: "worktree",
        status: "working",
        agent_harness: "claude-code",
      });
      const reason =
        "This chat already has 20 messages waiting. Remove one, or wait for the agent to take them.";
      const error = vi.spyOn(toast, "error").mockReturnValue("refused");
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(platform, "isMac", "get").mockReturnValue(true);
      vi.spyOn(ws, "isConnected").mockReturnValue(true);
      const call = vi.spyOn(ws, "call").mockRejectedValueOnce(new ws.OpError(reason));
      render(
        createElement(SessionComposer, { sessionId: "test", initialModel: "claude-code:opus" })
      );
      controls.input.mock.lastCall![0].onKeyDown({
        key: "Enter",
        metaKey,
        nativeEvent: {},
        preventDefault: vi.fn(),
      });
      await vi.waitFor(() => expect(error).toHaveBeenCalledExactlyOnceWith(reason));
      expect(call).toHaveBeenCalledExactlyOnceWith(
        op,
        expect.objectContaining({ content: "Follow up" })
      );
      expect(store.getState().composers.test.draft).toBe("Follow up");
    }
  );

  it.each([
    ["a turn record", [{ turnId: "A" }], "older", "A"],
    ["this window's optimistic bubble", [], "minted-here", "minted-here"],
    ["a settled turn", [{ turnId: "ended", endedAt: 100 }], "ended", undefined],
  ] as const)(
    "steers the turn shown by %s even if a new turn arrives before the write",
    async (_case, turns, newest, expected) => {
      client.setQueryData(queryKeys.sessions.detail("test"), {
        id: "test",
        status: "working",
        agent_harness: "claude-code",
        workspace_kind: "worktree",
      });
      const pageKey = queryKeys.sessions.messages("test");
      client.setQueryData(pageKey, { messages: [{ turn_id: newest }], turns, compactions: [] });
      vi.spyOn(platform, "isMac", "get").mockReturnValue(true);
      const connecting = Promise.withResolvers<void>();
      vi.spyOn(ws, "isConnected").mockReturnValue(false);
      vi.spyOn(ws, "connect").mockReturnValue(connecting.promise);
      const call = vi.spyOn(ws, "call").mockResolvedValue({ outcome: "queued" });
      render(
        createElement(SessionComposer, { sessionId: "test", initialModel: "claude-code:opus" })
      );
      controls.input.mock.lastCall![0].onKeyDown({
        key: "Enter",
        metaKey: true,
        nativeEvent: {},
        preventDefault: vi.fn(),
      });
      client.setQueryData(pageKey, { messages: [], turns: [{ turnId: "B" }], compactions: [] });
      connecting.resolve();
      await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
      const [[op, input]] = call.mock.calls;
      expect(op).toBe(api.steerMessage);
      expect(input.turnId).toBe(expected);
    }
  );

  it("leaves Enter to the phone keyboard and clears the draft accepted through the Queue button", async () => {
    controls.mobile.mockReturnValueOnce(true);
    const send = vi.fn(() => true);
    const html = renderInput({ workspaceKind: "worktree", sessionStatus: "working", onSend: send });
    expect(html).toContain('title="Queue message"');
    const key = controls.input.mock.lastCall![0].onKeyDown;
    const enter = { key: "Enter", nativeEvent: {}, preventDefault: vi.fn() };
    key(enter);
    key({ ...enter, metaKey: true });
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    button("Queue message").onClick();
    await vi.waitFor(() => expect(store.getState().composers.test.draft).toBe(""));
    expect(send).toHaveBeenCalledExactlyOnceWith("Follow up", undefined);
  });
});

describe("the composer's placeholder", () => {
  const placeholder = (workspaceKind: "worktree" | "cloud") => {
    const html = renderInput({
      workspaceKind,
      workspacePath: workspaceKind === "cloud" ? null : "/Users/me/rocket",
    });
    return /placeholder="([^"]*)"/.exec(html)?.[1];
  };

  it("names / skills in a cloud chat only when its menu has something", () => {
    cloudSkills.items = [];
    expect(placeholder("cloud")).toBe("Ask a follow-up… (@ files)");
    cloudSkills.items = [{ name: "review", description: "Review", kind: "skill" }];
    expect(placeholder("cloud")).toBe("Ask a follow-up… (@ files, / skills)");
    cloudSkills.items = [];
  });

  it("names / skills on this computer", () => {
    expect(placeholder("worktree")).toBe("Ask a follow-up… (@ files, / skills)");
  });
});

describe("the plan mode toggle", () => {
  const hasToggle = (initialModel: string, workspaceKind: "worktree" | "cloud") =>
    renderInput({ initialModel, workspaceKind }).includes('aria-label="Plan mode"');

  it("is offered on the local agents that can plan", () => {
    expect(hasToggle("claude-code:opus", "worktree")).toBe(true);
    expect(hasToggle("codex-app-server:gpt-6.1-sol", "worktree")).toBe(true);
    expect(hasToggle("gemini:gemini-4-neon", "worktree")).toBe(false);
    expect(hasToggle("codex-app-server:gpt-6.1-sol", "cloud")).toBe(false);
  });
});
