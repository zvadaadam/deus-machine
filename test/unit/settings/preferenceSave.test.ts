import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { useUpdateSettings } from "@/features/settings/api/settings.queries";
import { queryKeys } from "@/shared/api/queryKeys";
import { CLOUD_SETTINGS_QUERY_KEY } from "@/shared/hooks/useCloudSettings";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ws")>()),
  call,
}));
vi.mock("@/platform/analytics", () => ({ track: vi.fn() }));

describe("saving a preference", () => {
  it("refreshes the preferences and leaves the cloud settings alone", async () => {
    const client = new QueryClient();
    const readPreferences = vi.fn(async () => ({ theme: "dark" }));
    const readCloud = vi.fn(async () => ({ signedIn: true }));
    const observers = [
      new QueryObserver(client, { queryKey: queryKeys.settings.all, queryFn: readPreferences }),
      new QueryObserver(client, { queryKey: CLOUD_SETTINGS_QUERY_KEY, queryFn: readCloud }),
    ];
    const unsubscribe = observers.map((observer) => observer.subscribe(() => {}));
    call.mockResolvedValue(undefined);

    let save!: ReturnType<typeof useUpdateSettings>["mutateAsync"];
    function Probe() {
      save = useUpdateSettings().mutateAsync;
      return null;
    }
    try {
      renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
      await vi.waitFor(() => {
        expect(readPreferences).toHaveBeenCalledTimes(1);
        expect(readCloud).toHaveBeenCalledTimes(1);
      });

      await save({ theme: "light" });

      expect(call).toHaveBeenCalledWith(api.saveSetting, { key: "theme", value: "light" });
      await vi.waitFor(() => expect(readPreferences).toHaveBeenCalledTimes(2));
      expect(readCloud).toHaveBeenCalledTimes(1);
      expect(client.getQueryState(CLOUD_SETTINGS_QUERY_KEY)?.isInvalidated).toBe(false);
    } finally {
      unsubscribe.forEach((stop) => stop());
      call.mockReset();
      client.clear();
    }
  });
});
