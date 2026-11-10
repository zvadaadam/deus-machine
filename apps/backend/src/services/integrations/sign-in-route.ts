// backend/src/services/integrations/sign-in-route.ts
// How an app's account is reached right now. Most apps sign in directly, on
// this computer (the MCP OAuth flow, a pasted key, nothing). Two kinds go
// through a broker in Deus Cloud instead: an app with no server of its own,
// and an app whose own sign-in needs a vendor-approved client Deus does not
// have yet. The second kind moves to its direct route by itself the day that
// client exists, with no change to the catalog.

import type { AppUnavailable, CatalogApp } from "@shared/integrations/types";
import { registeredClient } from "./auth/clients";
import { brokerLabel, cloudRouteAvailability } from "./auth/cloud-accounts";

export type SignInRoute =
  | { via: "direct" }
  | { via: "cloud"; broker: NonNullable<CatalogApp["broker"]>; label: string }
  | { via: "unavailable"; reason: AppUnavailable };

function cloudRoute(app: CatalogApp): SignInRoute {
  if (!app.broker) return { via: "unavailable", reason: "soon" };
  const availability = cloudRouteAvailability(app.broker);
  return availability === "ready"
    ? { via: "cloud", broker: app.broker, label: brokerLabel(app.broker) }
    : { via: "unavailable", reason: availability };
}

export function signInRoute(app: CatalogApp): SignInRoute {
  if (app.auth.kind === "managed") return cloudRoute(app);
  if (app.auth.kind === "oauth" && app.auth.registration === "preregistered") {
    return registeredClient(app.id) ? { via: "direct" } : cloudRoute(app);
  }
  return { via: "direct" };
}
