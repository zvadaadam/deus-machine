import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { useRelayStatus } from "@/features/settings/api/auth.queries";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";

vi.mock("@/shared/hooks/useQuerySubscription", () => ({ useQuerySubscription: vi.fn() }));

it.each([true, false])(
  "follows the relay while remote access is enabled (%s), without polling",
  (enabled) => {
    const client = new QueryClient();
    function Settings() {
      useRelayStatus(enabled);
      return null;
    }
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Settings)));
    const [query] = client.getQueryCache().getAll();
    expect(useQuerySubscription).toHaveBeenLastCalledWith(api.relayStatus, {
      queryKey: query.queryKey,
      enabled,
    });
    expect(query.options).toMatchObject({
      enabled,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
    });
    expect(query.options).not.toHaveProperty("refetchInterval", expect.any(Number));
    client.clear();
  }
);
