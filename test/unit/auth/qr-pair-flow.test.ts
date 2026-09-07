/**
 * Regression guard: the `/connect/$serverId` → `/s/$serverId` redirect must
 * preserve the `?pair=` query so QR / shared-link arrivals reach
 * `PairGatePage` with the pair code intact and the auto-connect branch
 * (not the manual-entry fallback) fires.
 *
 * The redirect lives in `connectServerRoute.beforeLoad` in `@/app/router`.
 * It MUST pass `search: true` to `redirect()` — omitting it makes TanStack
 * Router's `applySearchMiddleware` `final` step return `{}` and silently
 * drop the query. This test drives the QR URL through the REAL `webRouter`
 * route tree so a future revert of `search: true` fails here.
 *
 * Run: `node node_modules/vitest/vitest.mjs run --config test/vitest.config.ts
 *        unit/auth/qr-pair-flow.test.ts`
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createMemoryHistory } from "@tanstack/react-router";

// TanStack Router's `RouterCore.update` reads `window?.origin` when running
// in client mode (`isServer: false`). Vitest's `environment: "node"` has no
// `window`; stub a minimal one so the router initializes.
let windowWasDefined = false;
beforeAll(() => {
  windowWasDefined = typeof (globalThis as { window?: unknown }).window !== "undefined";
  if (!windowWasDefined) (globalThis as { window: unknown }).window = {};
});
afterAll(() => {
  if (!windowWasDefined) delete (globalThis as { window?: unknown }).window;
});

// Stub heavy route-component modules so the real route tree loads under node.
vi.mock("@/app/routes/root", () => ({ RootLayout: () => null }));
vi.mock("@/app/routes/connect", () => ({ ConnectPage: () => null }));
vi.mock("@/app/shells/ServerLayout", () => ({ ServerLayout: () => null }));
vi.mock("@/app/routes/workspace", () => ({ WorkspaceRoute: () => null }));
vi.mock("@/app/routes/settings", () => ({ SettingsRoute: () => null }));
vi.mock("@/shared/config/backend.config", () => ({
  getDeploymentMode: () => "web-production",
  isRelayMode: () => true,
  RELAY_BASE_URL: "wss://relay.example.com",
}));

describe("connectServerRoute redirect preserves ?pair= for QR-pair auto-connect", () => {
  it("commits /s/$serverId?pair=... when arriving at /connect/$serverId?pair=...", async () => {
    const { webRouter } = await import("@/app/router");

    // `webRouter` is constructed at module load with `isServer` defaulting to
    // true (no `document` in node), so it has no history. Inject a memory
    // history and force client mode so the production non-SSR redirect-commit
    // path fires and mutates `latestLocation`.
    const history = createMemoryHistory({
      initialEntries: ["/connect/abc12345?pair=SOFT+TIGER"],
    });
    webRouter.update({ history, isServer: false } as never);
    await webRouter.load();

    const loc = webRouter.latestLocation;
    expect(loc.pathname).toBe("/s/abc12345");
    // TanStack's default `parseSearch` (URLSearchParams) decodes `+` -> space,
    // so the value `PairGatePage.getPairFromUrl()` reads is "SOFT TIGER".
    expect((loc.search as { pair?: unknown }).pair).toBe("SOFT TIGER");
    expect(loc.href).toContain("pair=SOFT+TIGER");
  });
});
