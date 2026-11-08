import { describe, expect, it } from "vitest";
import { createQueryClient } from "@/shared/api/queryClient";
import { RuntimeClient, runtimeForQueryClient } from "@/platform/ws/runtime-client";

// Package tests exercise transport/cache behavior. These are the app's policies.
describe("Deus runtime binding", () => {
  it("owns a cache with mutation retries disabled", () => {
    const client = new RuntimeClient(
      { host: "host", account: "account", grant: "grant" },
      {
        open: () => {
          throw new Error("No socket needed");
        },
      }
    );
    expect(runtimeForQueryClient(client.queryClient)).toBe(client);
    expect(client.queryClient.getDefaultOptions().mutations?.retry).toBe(false);
    client.dispose();
  });

  it("preserves the injected cache used by the app provider", () => {
    const cache = createQueryClient();
    const client = new RuntimeClient(
      { host: "host", account: "account", grant: "grant" },
      {
        queryClient: cache,
        open: () => {
          throw new Error("No socket needed");
        },
      }
    );
    expect(client.queryClient).toBe(cache);
    expect(runtimeForQueryClient(cache)).toBe(client);
    client.dispose();
  });
});
