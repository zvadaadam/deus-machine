import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@shared/api/browser";
import type { LocalServersSnapshot } from "@shared/types/local-server";
import { LOCAL_CALLER, Registry } from "../../../src/api/registry";
import { operations } from "../../helpers";

const servers = vi.hoisted(() => ({ getDiscoveredServers: vi.fn() }));
vi.mock("../../../src/services/local-servers.service", () => servers);

const cloud = vi.hoisted(() => ({ readCloudPreviewTemplate: vi.fn() }));
vi.mock("../../../src/services/agent/cloud/driver", () => cloud);

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
    expect(api.localServers).toMatchObject({ name: "local_servers", kind: "read", live: true });
  });

  it("answers a subscriber in the same tick, from the last sweep", () => {
    servers.getDiscoveredServers.mockReturnValue(snapshot);
    const live = new Registry(handlers).runLive("local_servers", {}, { caller: LOCAL_CALLER });
    expect(live).toBe(snapshot);
  });

  it("answers a one-shot read too", async () => {
    servers.getDiscoveredServers.mockReturnValue(snapshot);
    await expect(run(api.localServers)).resolves.toEqual(snapshot);
  });
});

describe("a cloud workspace's preview address", () => {
  it.each([
    ["the template", "https://{{port}}-sb1.e2b.app"],
    ["null when the platform reports no sandbox", null],
    ["nothing when the backend has not been told yet", undefined],
  ])("answers %s", async (_what, template) => {
    cloud.readCloudPreviewTemplate.mockReturnValue(template);
    await expect(run(api.cloudPreview, { workspaceId: "ws-1" })).resolves.toBe(template);
    expect(cloud.readCloudPreviewTemplate).toHaveBeenCalledExactlyOnceWith("ws-1");
  });

  it("needs to know which workspace", async () => {
    await expect(run(api.cloudPreview, {} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "cloudPreview requires workspaceId",
    });
    expect(cloud.readCloudPreviewTemplate).not.toHaveBeenCalled();
  });
});
