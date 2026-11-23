import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import type { QueuedMessages } from "@shared/api/sessions";
import { queryKeys } from "@/shared/api/queryKeys";
import { QueuedMessageList } from "@/features/session/ui/QueuedMessageList";
import {
  composerStore,
  sessionComposerActions,
} from "@/features/session/store/sessionComposerStore";

const { button, call, subscribe, error } = vi.hoisted(() => ({
  button: vi.fn(),
  call: vi.fn(),
  subscribe: vi.fn(),
  error: vi.fn(),
}));
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
const item = { id: "waiting", text: "Review this", images: 2, steering: false };

function render(data: QueuedMessages, canSteer = true) {
  client.setQueryData(queryKey, data);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(QueuedMessageList, { sessionId, canSteer })
    )
  );
}

function click(label: string) {
  const props = button.mock.calls.find(([p]) => (p["aria-label"] ?? p.children) === label)![0];
  return props.onClick();
}

afterEach(() => {
  client.clear();
  sessionComposerActions.discard(sessionId);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("shows the host's unread steer first and leaves it without actions", () => {
  const waiting = { ...item, text: "", images: 1 };
  const html = render({
    paused: null,
    items: [{ id: "read-next", text: "Change direction", images: 2, steering: true }, waiting],
  });
  expect(subscribe).toHaveBeenCalledExactlyOnceWith(api.queuedMessages, {
    queryKey,
    params: { sessionId },
  });
  expect(html).toMatch(
    /Waiting to be read.*Change direction.*2 images.*>Queued<.*1 image.*>Steer</s
  );
  expect(button.mock.calls.map(([p]) => p["aria-label"] ?? p.children)).toEqual([
    "Steer",
    "Edit queued message",
    "Remove queued message",
  ]);
});

it.each([
  ["stopped", "Queue paused. The agent was stopped."],
  ["failed", "Queue paused. The last turn failed."],
] as const)("keeps a %s queue on screen until Resume reaches the host", async (paused, reason) => {
  const items = [item];
  const html = render({ paused, items }, false);
  expect(html).toContain(reason);
  expect(html).toContain("Review this");
  expect(html).not.toContain(">Steer<");
  call.mockResolvedValueOnce({});
  await click("Resume");
  expect(call).toHaveBeenCalledExactlyOnceWith(api.resumeQueuedMessages, { sessionId });
  expect(client.getQueryData(queryKey)).toEqual({ paused, items });
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

it.each([true, false])(
  "returns the saved text and picture to the composer only if Edit removed them (%s)",
  async (removed) => {
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
    render({ paused: null, items: [item] });
    const content = JSON.stringify([
      { type: "text", text: "Original full message" },
      { type: "image", mimeType: "image/png", data: "AQID" },
    ]);
    call.mockResolvedValueOnce({ content: removed ? content : null });
    await click("Edit queued message");
    expect(call).toHaveBeenCalledExactlyOnceWith(api.removeQueuedMessage, {
      sessionId,
      id: item.id,
    });
    const draft = composerStore(client).getState().pendingContent[sessionId]!;
    expect(draft.draft).toBe(removed ? "Original full message\n\nTyped since" : "Typed since");
    expect(draft.imageAttachments.map((image) => image.preview)).toEqual(
      removed ? ["data:image/png;base64,AQID"] : []
    );
    expect(error).not.toHaveBeenCalled();
  }
);

it("steers and removes by id without changing the cached rows or the draft", async () => {
  const data = { paused: null, items: [item] };
  render(data);
  call.mockResolvedValueOnce({ outcome: "queued" });
  await click("Steer");
  call.mockResolvedValueOnce({ content: "Removed message" });
  await click("Remove queued message");
  expect(call.mock.calls).toEqual([
    [api.steerQueuedMessage, { sessionId, id: item.id }],
    [api.removeQueuedMessage, { sessionId, id: item.id }],
  ]);
  expect(composerStore(client).getState().pendingContent[sessionId]).toBeUndefined();
  expect(client.getQueryData(queryKey)).toEqual(data);
  expect(error).not.toHaveBeenCalled();
});
