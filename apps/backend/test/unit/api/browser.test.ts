import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@shared/api/browser";
import type { LocalServersSnapshot } from "@shared/types/local-server";
import { LOCAL_CALLER, Registry } from "../../../src/api/registry";
import { operations } from "../../helpers";

const servers = vi.hoisted(() => ({ getDiscoveredServers: vi.fn() }));
vi.mock("../../../src/services/local-servers.service", () => servers);

import handlers from "../../../src/api/browser";

const run = operations(handlers);

beforeEach(() => vi.resetAllMocks());

describe("local dev servers", () => {
  const snapshot: LocalServersSnapshot = {
    servers: [
      {
        url: "http://localhost:3000/",
        host: "localhost",
        port: 3000,
        title: "Dev",
        theme: null,
        previewImageDataUrl: null,
        status: "running",
        source: "port-scan",
      },
    ],
    isLoading: false,
    refreshedAt: 1,
  };

  it("keeps the name the discovery sweep invalidates", () => {
    expect(api.localServers).toMatchObject({ name: "localServers", kind: "read", live: true });
  });

  it("answers a subscriber in the same tick, from the last sweep", () => {
    servers.getDiscoveredServers.mockReturnValue(snapshot);
    const live = new Registry(handlers).runLive("localServers", {}, { caller: LOCAL_CALLER });
    expect(live).toBe(snapshot);
  });

  it("answers a one-shot read too", async () => {
    servers.getDiscoveredServers.mockReturnValue(snapshot);
    await expect(run(api.localServers)).resolves.toEqual(snapshot);
  });
});
