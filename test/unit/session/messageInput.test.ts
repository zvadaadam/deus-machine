import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatModel } from "@/shared/hooks/useModelLists";
import { queryKeys } from "@/shared/api/queryKeys";
import { SessionComposer } from "@/features/session/ui/SessionComposer";
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
vi.mock("@/features/session/ui/ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("@/shared/hooks/useQuerySubscription", () => ({ useQuerySubscription: () => {} }));
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
function renderInput(props: Partial<ComponentProps<typeof Input>>) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        TooltipProvider,
        null,
        createElement(Input, {
          sessionId: "test",
          sending: false,
          sessionStatus: "idle",
          onStop: vi.fn(),
          onSend: vi.fn(),
          ...props,
        })
      )
    )
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
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            TooltipProvider,
            null,
            createElement(SessionComposer, { sessionId: id, initialModel })
          )
        )
      );
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
