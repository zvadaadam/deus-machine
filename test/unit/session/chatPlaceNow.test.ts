import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

// This client: the desktop app or not, and the settings it has read.
const client = vi.hoisted(() => ({ desktop: true, queryClient: null as unknown }));
vi.mock("@/platform/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/capabilities")>();
  return {
    ...actual,
    capabilities: new Proxy(actual.capabilities, {
      get: (target, key) => (key === "nativeBrowser" ? client.desktop : Reflect.get(target, key)),
    }),
  };
});
vi.mock("@/platform/ws", () => ({
  call: vi.fn(),
  getRuntimeClient: () => ({ queryClient: client.queryClient }),
}));
vi.mock("@/shared/hooks/use-mobile", () => ({ isMobileViewport: () => false }));

import { chatPlaceNow } from "@/features/session/lib/openFromChat";
import { openAddress } from "@/features/workspace/lib/reach";
import { queryKeys } from "@/shared/api/queryKeys";

const at = async (browserSetting: boolean) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.settings.all, { experimental_browser: browserSetting });
  client.queryClient = queryClient;
  const place = await chatPlaceNow("ws-1", { cloud: false, folder: "/r/.deus/a" });
  return openAddress("https://example.com", place).to;
};

beforeEach(() => {
  client.desktop = true;
});

describe("a link in a local workspace's chat", () => {
  it("opens the Browser tab where this client has one", async () => {
    expect(await at(true)).toBe("browser-tab");
  });

  it("opens the person's browser where the tab is off, or this client has none", async () => {
    expect(await at(false)).toBe("external");
    client.desktop = false;
    expect(await at(true)).toBe("external");
  });
});
