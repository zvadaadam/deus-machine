// backend/src/services/integrations/auth/clients.ts
// OAuth clients Deus has registered with vendors whose MCP servers do not
// accept dynamic client registration (Slack, Google, HubSpot, Box, Zoom…).
// Catalog apps marked `registration: "preregistered"` use the client found
// here; without one they go through their broker, or show as coming soon
// (sign-in-route.ts).
//
// Today the source is configuration (`DEUS_OAUTH_CLIENTS`, a JSON object of
// app id → { client_id, client_secret? }) so a developer can try a vendor
// with their own app. Where the shipped clients live — Deus Cloud, which
// would also hold confidential secrets and exchange codes for the desktop —
// is the open decision this seam leaves room for.

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
}

let cached: { raw: string | undefined; clients: Record<string, RegisteredClient> } | null = null;

function configured(): Record<string, RegisteredClient> {
  const raw = process.env.DEUS_OAUTH_CLIENTS;
  if (cached && cached.raw === raw) return cached.clients;
  let clients: Record<string, RegisteredClient> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      clients = Object.fromEntries(
        Object.entries(parsed).flatMap(([appId, value]) => {
          const client = value as Partial<RegisteredClient> | null;
          return client && typeof client.client_id === "string"
            ? [[appId, client as RegisteredClient]]
            : [];
        })
      );
    } catch {
      console.warn("[Integrations] DEUS_OAUTH_CLIENTS is not valid JSON; ignoring it");
    }
  }
  cached = { raw, clients };
  return clients;
}

export function registeredClient(appId: string): RegisteredClient | null {
  return configured()[appId] ?? null;
}
