import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import {
  useEditableSettings,
  useSettings,
  useUpdateSettings,
} from "@/features/settings/api/settings.queries";
import { call } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";

vi.mock("@/platform/ws", () => ({ call: vi.fn() }));
vi.mock("@/platform/analytics", () => ({ track: vi.fn() }));
vi.mock("@/shared/hooks/useQuerySubscription", () => ({ useQuerySubscription: vi.fn() }));
vi.mock("@/shared/config/webDirectMode", () => ({ isCloudDirectWebMode: vi.fn() }));

afterEach(() => vi.clearAllMocks());

function preferences(client: QueryClient) {
  let state!: ReturnType<typeof useEditableSettings>;
  let save!: ReturnType<typeof useUpdateSettings>["mutateAsync"];
  function Window() {
    state = useEditableSettings();
    save = useUpdateSettings().mutateAsync;
    return null;
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Window)));
  return { settings: state.settings, save };
}

it.each([true, false])(
  "subscribes to this computer's preferences only when it serves the window (hosted=%s)",
  (hosted) => {
    vi.mocked(isCloudDirectWebMode).mockReturnValue(hosted);
    const client = new QueryClient();
    function Window() {
      useSettings();
      return null;
    }
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Window)));
    const queryKey = queryKeys.settings.all;
    expect(useQuerySubscription).toHaveBeenCalledWith(api.settings, { queryKey, enabled: !hosted });
    expect(client.getQueryCache().find({ queryKey })?.options).toMatchObject({
      staleTime: Infinity,
      refetchOnWindowFocus: false,
    });
    client.clear();
  }
);

it.each(["saved", "superseded", "refused"])(
  "shows the pending control value and keeps the host's preferences when the write is %s",
  async (outcome) => {
    const client = new QueryClient();
    const key = queryKeys.settings.all;
    const read = vi.fn(async () => ({}));
    const stop = new QueryObserver(client, { queryKey: key, queryFn: read }).subscribe(() => {});
    const control = () => preferences(client).settings.chat_view ?? "bubbles";
    try {
      await vi.waitFor(() => expect(client.getQueryData(key)).toEqual({}));
      expect(control()).toBe("bubbles");
      const ack = Promise.withResolvers<void>();
      vi.mocked(call).mockReturnValueOnce(ack.promise);
      const saving = preferences(client).save({ key: "chat_view", value: "full" });
      await vi.waitFor(() =>
        expect(call).toHaveBeenCalledExactlyOnceWith(api.saveSetting, {
          key: "chat_view",
          value: "full",
        })
      );
      expect(control()).toBe("full");
      expect(client.getQueryData(key)).toEqual({});
      client.setQueryData(key, { diff_view_mode: "split" });
      expect(control()).toBe("full");
      if (outcome === "refused") {
        ack.reject(new Error("Refused"));
        await expect(saving).rejects.toThrow("Refused");
        expect(control()).toBe("bubbles");
      } else {
        const pushed = {
          chat_view: outcome === "saved" ? "full" : "bubbles",
          diff_view_mode: "split",
        };
        client.setQueryData(key, pushed);
        expect(control()).toBe("full");
        ack.resolve();
        await saving;
        expect(control()).toBe(pushed.chat_view);
        expect(client.getQueryData(key)).toEqual(pushed);
      }
      expect(read).toHaveBeenCalledOnce();
    } finally {
      stop();
      client.clear();
    }
  }
);

it.each([false, true])(
  "holds the latest on → off → on choice through host pushes (latest settles first=%s)",
  async (latestFirst) => {
    const client = new QueryClient();
    const key = queryKeys.settings.all;
    const push = (value: boolean) => client.setQueryData(key, { agent_messages: value });
    const control = () => preferences(client).settings.agent_messages;
    push(true);
    const { save } = preferences(client);
    function choose(value: boolean) {
      const ack = Promise.withResolvers<void>();
      vi.mocked(call).mockReturnValueOnce(ack.promise);
      const saved = save({ key: "agent_messages", value });
      return async () => {
        ack.resolve();
        await saved;
      };
    }
    try {
      expect(control()).toBe(true);
      const off = choose(false);
      expect(control()).toBe(false);
      const on = choose(true);
      expect(control()).toBe(true);
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
      push(false);
      expect(client.getQueryData(key)).toEqual({ agent_messages: false });
      expect(control()).toBe(true);
      push(true);
      const [first, last] = latestFirst ? [on, off] : [off, on];
      await first();
      expect(control()).toBe(true);
      push(false);
      expect(control()).toBe(!latestFirst);
      await last();
      expect(control()).toBe(false);
    } finally {
      client.clear();
    }
  }
);
