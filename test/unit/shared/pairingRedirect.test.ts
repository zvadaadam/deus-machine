import { describe, expect, it, vi } from "vitest";
import { createMemoryHistory } from "@tanstack/react-router";

// Exercise the production route tree without mounting the application or its sockets.
vi.mock("@/app/routes/root", () => ({ RootLayout: () => null }));
vi.mock("@/app/routes/connect", () => ({ ConnectPage: () => null }));
vi.mock("@/app/shells/ServerLayout", () => ({ ServerLayout: () => null }));
vi.mock("@/app/routes/workspace", () => ({ WorkspaceRoute: () => null }));
vi.mock("@/app/routes/settings", () => ({ SettingsRoute: () => null }));
vi.mock("@/shared/config/backend.config", () => ({ getDeploymentMode: () => "relay" }));

import { webRouter } from "@/app/router";

describe("pairing link browser fallback", () => {
  it("retains the code when /connect redirects into the Mac's route", async () => {
    const history = createMemoryHistory({ initialEntries: ["/connect/abcdef12?pair=ABLE+ACID"] });
    webRouter.update({ history, isServer: false, origin: "https://deusmachine.ai" });
    await webRouter.load();
    const destination = new URL(history.location.href, "https://deusmachine.ai");
    expect(destination.pathname).toBe("/s/abcdef12");
    expect(destination.searchParams.get("pair")).toBe("ABLE ACID");
  });
});
