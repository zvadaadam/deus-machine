/**
 * TanStack Router definition for web (non-Electron) mode.
 *
 * Route tree:
 *   / (RootLayout)
 *   +-- /connect           -> ConnectPage (enter server ID)
 *   +-- /connect/$serverId  -> ConnectPage (pre-filled server)
 *   +-- /s/$serverId        -> ServerLayout (wraps nested routes)
 *       +-- /               -> redirects to last workspace
 *       +-- /w/$workspaceId -> WorkspaceRoute
 *       +-- /settings       -> SettingsRoute
 *
 * Shared components (MainLayout, SettingsPage, etc.) NEVER import from
 * @tanstack/react-router. Route components are thin wrappers that extract
 * params and pass them as props.
 */

import { createRouter, createRootRoute, createRoute, redirect } from "@tanstack/react-router";
import { RootLayout } from "./routes/root";
import { ConnectPage } from "./routes/connect";
import { ServerLayout } from "./shells/ServerLayout";
import { WorkspaceRoute } from "./routes/workspace";
import { SettingsRoute } from "./routes/settings";
import { getDeploymentMode } from "@/shared/config/backend.config";

// --- Root route ---
const rootRoute = createRootRoute({
  component: RootLayout,
});

// --- /connect (no server ID) ---
const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connect",
  component: ConnectPage,
});

// --- /connect/$serverId (direct link — go straight to server context) ---
const connectServerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connect/$serverId",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/s/$serverId", params: { serverId: params.serverId } });
  },
});

// --- /s/$serverId (server layout with nested routes) ---
const serverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$serverId",
  component: ServerLayout,
});

// --- /s/$serverId/ (index -- redirect to last workspace or show default) ---
const serverIndexRoute = createRoute({
  getParentRoute: () => serverRoute,
  path: "/",
  component: WorkspaceRoute,
});

// --- /s/$serverId/w/$workspaceId ---
const workspaceRoute = createRoute({
  getParentRoute: () => serverRoute,
  path: "/w/$workspaceId",
  component: WorkspaceRoute,
});

// --- /s/$serverId/settings ---
const settingsRoute = createRoute({
  getParentRoute: () => serverRoute,
  path: "/settings",
  component: SettingsRoute,
});

// --- / (root index, redirect) ---
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    // In web-dev mode, skip the connect screen — go straight to the app
    // with a dummy serverId (the actual connection uses VITE_BACKEND_PORT).
    if (getDeploymentMode() === "web-dev") {
      throw redirect({ to: "/s/$serverId", params: { serverId: "local" } });
    }
    throw redirect({ to: "/connect" });
  },
});

// --- Route tree ---
const routeTree = rootRoute.addChildren([
  indexRoute,
  connectRoute,
  connectServerRoute,
  serverRoute.addChildren([serverIndexRoute, workspaceRoute, settingsRoute]),
]);

// --- Router instance ---
export const webRouter = createRouter({
  routeTree,
  defaultPreload: "intent",
});

// Register router types for type-safe navigation
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof webRouter;
  }
}
