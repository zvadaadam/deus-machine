import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { queryClient, setActiveQueryClient } from "@/shared/api/queryClient";
import { queryKeys } from "@/shared/api/queryKeys";
import { useSettings, useUpdateSettings } from "@/features/settings/api/settings.queries";
import { GeneralSection } from "@/features/settings/ui/sections/GeneralSection";
import { stopAnalytics, track } from "@/platform/analytics";

const io = vi.hoisted(() => ({
  call: vi.fn(),
  toggle: undefined as ((checked: boolean) => Promise<void>) | undefined,
  sdk: {
    init: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    capture: vi.fn(),
    setPersonProperties: vi.fn(),
  },
}));
vi.mock("posthog-js", () => ({ default: io.sdk }));
vi.mock("@/platform/ws", () => ({ call: io.call }));
vi.mock("@/platform/capabilities", () => ({ capabilities: { ipcInvoke: true } }));
vi.mock("@/components/ui/switch", () => ({
  Switch: (props: { id: string; onCheckedChange: typeof io.toggle }) => {
    if (props.id === "analytics-toggle") io.toggle = props.onCheckedChange;
    return null;
  },
}));

const originalHost = queryClient;
function host() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setActiveQueryClient(cache);
  let read!: ReturnType<typeof useSettings>["refetch"];
  function Settings() {
    const query = useSettings();
    const save = useUpdateSettings();
    read = query.refetch;
    return createElement(GeneralSection, {
      settings: query.data ?? {},
      theme: "dark",
      setTheme: () => {},
      saveSetting: (key, value) =>
        save.mutateAsync({ [key]: value }).then(
          () => true,
          () => false
        ),
    });
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: cache }, createElement(Settings))
  );
  return { cache, read, toggle: io.toggle! };
}

afterEach(() => {
  stopAnalytics();
  setActiveQueryClient(originalHost);
  vi.unstubAllGlobals();
});

it("starts PostHog only for confirmed consent on the current host and stops on the opt-out click", async () => {
  vi.stubGlobal("__APP_VERSION__", "test");
  const version = Promise.withResolvers<string>();
  vi.stubGlobal("window", { electronAPI: { getAppVersion: () => version.promise } });
  const first = host();
  const initial = Promise.withResolvers<{ analytics_enabled: boolean }>();
  io.call.mockReturnValueOnce(initial.promise);
  const loading = first.read();
  track("onboarding_started");
  initial.resolve({ analytics_enabled: false });
  await loading;
  const denied = Promise.withResolvers<void>();
  io.call.mockReturnValueOnce(denied.promise);
  const saving = first.toggle(true);
  await vi.waitFor(() =>
    expect(io.call).toHaveBeenCalledWith(api.saveSetting, { key: "analytics_enabled", value: true })
  );
  expect(first.cache.getQueryData(queryKeys.settings.all)).toEqual({ analytics_enabled: false });
  track("onboarding_started");
  denied.reject(new Error("save refused"));
  await saving;
  for (const method of Object.values(io.sdk)) expect(method).not.toHaveBeenCalled();

  io.call.mockResolvedValueOnce(undefined);
  await first.toggle(true);
  track("onboarding_started");
  expect(io.sdk.capture).not.toHaveBeenCalled();
  io.call.mockResolvedValueOnce({ analytics_enabled: true, theme: "dark" });
  await first.read();
  version.resolve("1.2.3");
  await vi.waitFor(() =>
    expect(io.sdk.capture).toHaveBeenCalledWith("app_launched", { version: "1.2.3" })
  );
  expect(io.sdk.init).toHaveBeenCalledOnce();
  expect(io.sdk.setPersonProperties).toHaveBeenCalledExactlyOnceWith({ theme: "dark" });

  const off = Promise.withResolvers<void>();
  io.call.mockReturnValueOnce(off.promise);
  const optingOut = first.toggle(false);
  expect(io.sdk.opt_out_capturing).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(io.call).toHaveBeenCalledWith(api.saveSetting, {
      key: "analytics_enabled",
      value: false,
    })
  );
  io.call.mockResolvedValueOnce({ analytics_enabled: true });
  await first.read(); // A concurrent read still sees the old setting on the host.
  track("onboarding_started");
  expect(io.sdk.capture).toHaveBeenCalledTimes(1);
  off.resolve();
  await optingOut;

  io.call.mockResolvedValueOnce({ analytics_enabled: false });
  await first.read();
  // The first host enables analytics again. A subsequent host inherits no consent.
  io.call.mockResolvedValueOnce({ analytics_enabled: true });
  await first.read();
  const stale = Promise.withResolvers<{ analytics_enabled: boolean }>();
  io.call.mockReturnValueOnce(stale.promise);
  const oldRead = first.read();
  const second = host();
  track("onboarding_started");
  expect(io.sdk.init.mock.calls[0][1].before_send({ event: "sdk-event" })).toBeNull();
  stale.resolve({ analytics_enabled: true });
  await oldRead;
  io.call.mockResolvedValueOnce({ analytics_enabled: false });
  await second.read();
  track("onboarding_started");
  expect(io.sdk.opt_in_capturing).toHaveBeenCalledTimes(2);
  expect(io.sdk.setPersonProperties).toHaveBeenCalledTimes(2);
  expect(io.sdk.capture).toHaveBeenCalledTimes(1);
});
