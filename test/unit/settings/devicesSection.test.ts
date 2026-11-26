import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { DeviceSupport } from "@shared/types/device-hub";
import { DevicesSection } from "@/features/settings/ui/sections/DevicesSection";
import * as config from "@/shared/config/backend.config";

afterEach(() => vi.restoreAllMocks());

it.each(["available", "unsupported", "no-runtime"] as const)(
  "shows where to open Device only when the local tab exists (%s)",
  (liveView) => {
    vi.spyOn(config, "getDeploymentMode").mockReturnValue("web-dev");
    const client = new QueryClient();
    client.setQueryData<DeviceSupport>(["deviceSupport"], {
      liveView,
      xcode: { available: false, version: null },
      android: false,
      hubVersion: "1",
      agentDeviceVersion: "1",
    });
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(DevicesSection))
    );
    expect(html.includes("Open it from New Tab → Device.")).toBe(liveView === "available");
  }
);
