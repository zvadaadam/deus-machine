import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import type { QueuedMessages } from "@shared/api/sessions";
import { queryKeys } from "@/shared/api/queryKeys";
import { useEditQueuedMessage } from "@/features/session/api/session.queries";
import { QueuedMessageList } from "@/features/session/ui/QueuedMessageList";
import { SIDEBAR_WORKSPACE_STATE } from "@/features/workspace/api/workspace.queries";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  composerStore,
  sessionComposerActions,
} from "@/features/session/store/sessionComposerStore";

const { button, call, subscribe, error, presence, sortable } = vi.hoisted(() => ({
  button: vi.fn(),
  call: vi.fn(),
  subscribe: vi.fn(),
  error: vi.fn(),
  presence: vi.fn(() => true),
  sortable: vi.fn(),
}));
vi.mock("framer-motion", async (original) => ({
  ...(await original<typeof import("framer-motion")>()),
  useIsPresent: presence,
}));
vi.mock("@dnd-kit/sortable", async (original) => {
  const dnd = await original<typeof import("@dnd-kit/sortable")>();
  return {
    ...dnd,
    useSortable: (params: Parameters<typeof dnd.useSortable>[0]) => {
      sortable(params);
      return dnd.useSortable(params);
    },
  };
});
vi.mock("@/platform/ws", () => ({ call }));
vi.mock("@/shared/hooks/useQuerySubscription", () => ({ useQuerySubscription: subscribe }));
vi.mock("sonner", () => ({ toast: { error } }));
vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  return {
    ...actual,
    Button: (props: ComponentProps<typeof actual.Button>) => {
      button(props);
      return createElement(actual.Button, props);
    },
  };
});

const client = new QueryClient();
const sessionId = "queued-chat";
const queryKey = queryKeys.sessions.queued(sessionId);
const item = { id: "waiting", text: "Review this", images: 2, state: "waiting" } as const;
const params = { sessionId, id: item.id };

it("makes a departing row inert and removes it from drag and drop during its exit", () => {
  presence.mockReturnValueOnce(false);
  const html = render({ paused: null, items: [item] });
  expect(sortable).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: item.id, disabled: { draggable: true, droppable: true } })
  );
  expect(html).toContain('inert=""');
});

function List({ canSteer }: { canSteer: boolean }) {
  const { edit, editing } = useEditQueuedMessage(sessionId);
  return createElement(QueuedMessageList, {
    sessionId,
    turnId: "turn-on-screen",
    canSteer,
    onEdit: edit,
    editDisabled: editing,
  });
}

function render(data: QueuedMessages, canSteer = true) {
  client.setQueryData(queryKey, data);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TooltipProvider, null, createElement(List, { canSteer }))
    )
  );
}

function click(label: string, detail = 1) {
  const props = button.mock.calls.find(([p]) => (p["aria-label"] ?? p.children) === label)![0];
  return props.onClick({ detail });
}

afterEach(() => {
  client.clear();
  sessionComposerActions.discard(sessionId);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  ["steering", "Waiting to be read"],
  ["sending", "Sending"],
] as const)("shows the host's %s row first with its status and no actions", (state, status) => {
  const waiting = { ...item, text: "", images: 1 };
  const html = render({
    paused: null,
    items: [{ id: "head", text: "Change direction", images: 2, state }, waiting],
  });
  expect(subscribe).toHaveBeenCalledExactlyOnceWith(api.queuedMessages, {
    queryKey,
    params: { sessionId },
  });
  expect(html).toContain('aria-label="Queued messages"');
  expect(html).not.toContain(">Queued<");
  expect(html).toMatch(
    new RegExp(
      `Change direction.*aria-label="2 images".*>${status}<.*>1 image<.*aria-label="Send to current turn"`,
      "s"
    )
  );
  expect(button.mock.calls.map(([p]) => p["aria-label"] ?? p.children)).toEqual([
    "Reorder queued message 1",
    "Edit queued message",
    "Remove queued message",
    "Send to current turn",
  ]);
});

it.each([
  ["1 image", 1],
  ["2 images", 2],
] as const)("spells out %s alone and labels its icon beside text", (label, images) => {
  const withText = render({ paused: null, items: [{ ...item, images }] });
  expect(withText).toContain(`role="img" aria-label="${label}"`);
  expect(withText).toContain("lucide-image");
  expect(withText).toContain(`>${images}<`);
  expect(withText).not.toContain(`>${label}<`);

  const pictureOnly = render({ paused: null, items: [{ ...item, text: "", images }] });
  expect(pictureOnly).toContain(`>${label}<`);
  expect(pictureOnly).not.toContain("lucide-image");
});

it("links a queued message to its sending chat and leaves the person's row unmarked", () => {
  client.setQueryData(queryKeys.sessions.detail("sender"), { workspace_id: "w", title: "Review" });
  client.setQueryData(queryKeys.workspaces.byRepo(SIDEBAR_WORKSPACE_STATE), [
    { workspaces: [{ id: "w", title: "Review" }] },
  ]);
  const html = render({
    paused: null,
    items: [{ ...item, id: "review", origin: { kind: "session", sessionId: "sender" } }, item],
  });
  expect(html).toMatch(/Sent from<\/span>.*?<button[^>]*title="Review"[^>]*>Review<\/button>/s);
  expect(html.match(/Sent from/g)).toHaveLength(1);
});

it.each([
  ["stopped", "Queue paused. The agent was stopped."],
  ["failed", "Queue paused after an error."],
] as const)("keeps a %s queue on screen until Resume reaches the host", async (paused, reason) => {
  const items = [item];
  const html = render({ paused, items }, false);
  expect(html).toContain(reason);
  expect(html).toContain("Review this");
  expect(html).not.toContain('aria-label="Send to current turn"');
  call.mockResolvedValueOnce({});
  await click("Resume");
  expect(call).toHaveBeenCalledExactlyOnceWith(api.resumeQueuedMessages, { sessionId });
  expect(client.getQueryData(queryKey)).toEqual({ paused, items });
});

it.each(["stopped", "failed", "limit"] as const)(
  "shows a %s pause only while the queue has rows",
  (paused) => {
    const empty = render({ paused, items: [] });
    expect(empty).not.toMatch(/Queue paused|>Resume</);
    for (const state of ["waiting", "sending"] as const) {
      expect(render({ paused, items: [{ ...item, state }] })).toContain(">Resume<");
    }
  }
);

it("names only a future reset on the paused queue and keeps Resume available", () => {
  const reset = new Date(2026, 10, 24, 5, 10).getTime();
  vi.useFakeTimers({ now: reset - 1 });
  for (const [resetsAt, sentence] of [
    [reset, "Queue paused until 05:10."],
    [reset - 60_000, "Queue paused. A usage limit was reached."],
    [undefined, "Queue paused. A usage limit was reached."],
  ] as const) {
    const html = render({ paused: "limit", limit: { resetsAt, continues: false }, items: [item] });
    expect(html).toContain(sentence);
    expect(html).toContain(">Resume<");
  }
});

it("keeps twenty rows in order with a full preview for truncated text", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    ...item,
    id: String(i),
    text: `Follow-up ${i + 1} ${"long ".repeat(80)}`,
  }));
  const html = render({ paused: null, items }, false);
  expect(html.match(/aria-label="Edit queued message"/g)).toHaveLength(20);
  expect(html.indexOf(items[0].text)).toBeLessThan(html.indexOf(items[19].text));
  expect(html).toContain(`title="${items[19].text}"`);
});

it.each([true, false, "lost reply"] as const)(
  "keeps the restored text and picture after the host removes the row (Remove result %s)",
  async (result) => {
    vi.stubGlobal(
      "FileReader",
      class {
        onload!: (event: { target: { result: string } }) => void;
        async readAsDataURL(blob: Blob) {
          const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
          this.onload({ target: { result: `data:${blob.type};base64,${base64}` } });
        }
      }
    );
    sessionComposerActions.setDraft(sessionId, "Typed since");
    render({ paused: null, items: [{ ...item, text: "Original full message", images: 1 }] });
    const content = JSON.stringify([
      { type: "text", text: "Original full message" },
      { type: "image", mimeType: "image/png", data: "AQID" },
    ]);
    const remove = Promise.withResolvers<{ removed: boolean }>();
    call.mockResolvedValueOnce({ content }).mockReturnValueOnce(remove.promise);
    const edit = click("Edit queued message");
    await vi.waitFor(() =>
      expect(call.mock.calls).toEqual([
        [api.queuedMessage, params],
        [api.removeQueuedMessage, params],
      ])
    );
    const draft = () => composerStore(client).getState().pendingContent[sessionId];
    const restored = {
      draft: "Original full message\n\nTyped since",
      imageAttachments: [{ type: "image/png", preview: "data:image/png;base64,AQID" }],
    };
    expect(draft()).toMatchObject(restored);

    const emptyQueue: QueuedMessages = { paused: null, items: [] };
    client.setQueryData(queryKey, emptyQueue);
    if (result === "lost reply") remove.reject(new Error("Connection lost"));
    else remove.resolve({ removed: result });
    await edit;

    expect(client.getQueryData(queryKey)).toEqual(emptyQueue);
    expect(draft()).toMatchObject(restored);
    expect(error.mock.calls).toEqual(result === "lost reply" ? [["Connection lost"]] : []);
  }
);

it("leaves the draft alone when the message has already left the queue", async () => {
  sessionComposerActions.setDraft(sessionId, "Typed since");
  render({ paused: null, items: [item] });
  call.mockResolvedValueOnce({ content: null });
  await click("Edit queued message");
  expect(call).toHaveBeenCalledExactlyOnceWith(api.queuedMessage, params);
  expect(composerStore(client).getState().pendingContent[sessionId]?.draft).toBe("Typed since");
  expect(error).not.toHaveBeenCalled();
});

it("leaves the draft and row alone when Edit's read fails", async () => {
  const data = { paused: null, items: [item] };
  sessionComposerActions.setDraft(sessionId, "Typed since");
  render(data);
  call.mockRejectedValueOnce(new Error("Connection lost"));
  await click("Edit queued message");
  expect(call).toHaveBeenCalledExactlyOnceWith(api.queuedMessage, params);
  expect(client.getQueryData(queryKey)).toEqual(data);
  expect(composerStore(client).getState().pendingContent[sessionId]).toMatchObject({
    draft: "Typed since",
    imageAttachments: [],
  });
  expect(error).toHaveBeenCalledExactlyOnceWith("Connection lost");
});

it("a double click sends the row to the displayed turn once and leaves the host's rows intact", async () => {
  vi.stubGlobal("window", { clearTimeout });
  const data = { paused: null, items: [item] };
  render(data);
  call.mockResolvedValueOnce({ outcome: "queued" });
  await click("Send to current turn");
  await click("Send to current turn", 2);
  call.mockResolvedValueOnce({ removed: true });
  await click("Remove queued message");
  expect(call.mock.calls).toEqual([
    [api.steerQueuedMessage, { sessionId, id: item.id, turnId: "turn-on-screen" }],
    [api.removeQueuedMessage, { sessionId, id: item.id }],
  ]);
  expect(composerStore(client).getState().pendingContent[sessionId]).toBeUndefined();
  expect(client.getQueryData(queryKey)).toEqual(data);
  expect(error).not.toHaveBeenCalled();
});
