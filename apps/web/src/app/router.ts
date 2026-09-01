/**
 * TanStack Router definition for web (non-Electron) mode.
 *
 * Route tree:
 *   / (RootLayout)
 *   +-- web-direct product, AT THE ROOT (deusmachine.ai IS the app):
 *   |   +-- /               -> WorkspaceRoute (web-direct; else redirects)
 *   |   +-- /w/$workspaceId -> WorkspaceRoute
 *   |   +-- /settings       -> SettingsRoute
 *   +-- relay (Mac remote control), under its own URLs:
 *       +-- /connect            -> ConnectPage (enter server ID)
 *       +-- /connect/$serverId  -> ConnectPage (pre-filled server)
 *       +-- /s/$serverId        -> ServerLayout (wraps nested routes)
 *           +-- /               -> redirects to last workspace
 *           +-- /w/$workspaceId -> WorkspaceRoute
 *           +-- /settings       -> SettingsRoute
 *
 * One deployed build serves both audiences; `getDeploymentMode()` is
 * entry-path-scoped, so a relay URL keeps relay behavior on a web-direct build.
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

// --- Web-direct product at the ROOT (deusmachine.ai IS the app) ---
// A pathless layout so `/`, `/w/:id` and `/settings` render inside the same
// ServerLayout shell the /s tree uses (settings gate, q: protocol wiring — in
// web-direct the request interceptor answers instead of a socket). Guarded per
// route: on a non-web-direct build these paths bounce to the relay flows.

/** Redirect a product-root path to where this deployment actually serves the app. */
function guardWebDirect(): void {
  const mode = getDeploymentMode();
  if (mode === "web-direct") return;
  // web-dev serves the app under its synthetic server path.
  if (mode === "web-dev") {
    throw redirect({ to: "/s/$serverId", params: { serverId: "local" } });
  }
  throw redirect({ to: "/connect" });
}

const directLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "webDirect",
  component: ServerLayout,
});

const directIndexRoute = createRoute({
  getParentRoute: () => directLayoutRoute,
  path: "/",
  beforeLoad: guardWebDirect,
  component: WorkspaceRoute,
});

const directWorkspaceRoute = createRoute({
  getParentRoute: () => directLayoutRoute,
  path: "/w/$workspaceId",
  beforeLoad: guardWebDirect,
  component: WorkspaceRoute,
});

const directSettingsRoute = createRoute({
  getParentRoute: () => directLayoutRoute,
  path: "/settings",
  beforeLoad: guardWebDirect,
  component: SettingsRoute,
});

// --- Route tree ---
const routeTree = rootRoute.addChildren([
  directLayoutRoute.addChildren([directIndexRoute, directWorkspaceRoute, directSettingsRoute]),
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
