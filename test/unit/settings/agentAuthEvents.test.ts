import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { useAgentAuthEvents } from "@/features/settings/api/settings.queries";
import { queryKeys } from "@/shared/api/queryKeys";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { useStream } from "@/shared/hooks/useStream";

vi.mock("@/shared/config/webDirectMode", () => ({ isCloudDirectWebMode: vi.fn() }));
vi.mock("@/shared/hooks/useStream", () => ({ useStream: vi.fn() }));

const models = [...queryKeys.settings.agentModels, "workspace"];
function observe(direct = false) {
  vi.mocked(isCloudDirectWebMode).mockReturnValue(direct);
  vi.mocked(useStream).mockClear();
  const client = new QueryClient();
  client.setQueryData(models, { lists: [] });
  client.setQueryData(queryKeys.settings.agentAuth, { clis: [] });
  function Shell() {
    useAgentAuthEvents();
    return null;
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Shell)));
  return client;
}

it("does not follow either computer stream in the hosted direct lane", () => {
  observe(true);
  expect(vi.mocked(useStream).mock.calls.map(([stream, filter]) => [stream.name, filter])).toEqual([
    [api.agentCliProgress.name, null],
    [api.agentAuthChanges.name, null],
  ]);
});

it.each([api.agentCliProgress, api.agentAuthChanges])(
  "reads login and workspace models again after a missed $name event",
  (stream) => {
    const client = observe();
    const subscription = vi.mocked(useStream).mock.calls.find(([s]) => s === stream)!;
    expect(subscription[1]).toEqual({});
    subscription[3]!();
    expect(client.getQueryState(queryKeys.settings.agentAuth)?.isInvalidated).toBe(true);
    expect(client.getQueryState(models)?.isInvalidated).toBe(true);
  }
);

it("reads workspace models again when installation or sign-in finishes", () => {
  const client = observe();
  const [cli, auth] = vi.mocked(useStream).mock.calls;
  cli![2]({ harness: "gemini", phase: "ready", version: "1", receivedBytes: 0 });
  expect(client.getQueryState(models)?.isInvalidated).toBe(true);
  client.setQueryData(models, { lists: [] });
  auth![2]({ harness: "gemini" });
  expect(client.getQueryState(models)?.isInvalidated).toBe(true);
});
