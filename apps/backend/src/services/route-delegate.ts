// backend/src/services/route-delegate.ts
// Delegates q:request/q:mutate frames to existing Hono routes via in-process fetch.
//
// Instead of duplicating business logic, we construct an internal Request
// and dispatch it through the Hono app — the same pattern used by the
// HTTP-over-WS bridge in server.ts (onHttpRequest handler).
//
// The `relayBridged: true` env binding tells middleware that this is an
// internal request (not a remote HTTP call).

import type { Hono } from "hono";

/** Hono app reference, set once at startup via setApp(). */
let _app: Hono | null = null;

/**
 * Register the Hono app instance for in-process dispatch.
 * Called once from server.ts after createApp().
 */
export function setApp(app: Hono): void {
  _app = app;
}

/**
 * Dispatch an in-process request to a Hono route and return parsed JSON.
 *
 * Builds a Request object, dispatches through `app.fetch()`, parses the
 * JSON response, and throws on non-2xx status codes.
 *
 * On non-2xx, the thrown `Error` carries the HTTP `status` and the route's
 * structured `details` payload as own properties, so callers (notably
 * `query-engine.handleMutate`) can forward them on the `q:mutate_result`
 * failure frame and let frontend callers recover from conflicts like a 409
 * "Repository already exists" instead of surfacing the error.
 *
 * @param method - HTTP method (GET, POST, PATCH, DELETE)
 * @param path - Route path (e.g., "/api/settings")
 * @param body - Optional request body (will be JSON-serialized for non-GET)
 * @returns Parsed JSON response data
 * @throws Error on non-2xx status or missing app. The Error has `status`
 *         (number) and `details` (unknown, when the body carried one) attached
 *         as own properties.
 */
export async function delegateToRoute(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  if (!_app) {
    throw new Error("[route-delegate] Hono app not initialized — call setApp() first");
  }

  const headers: Record<string, string> = {};
  let requestBody: string | undefined;

  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    headers["content-type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  const request = new Request(`http://internal${path}`, {
    method,
    headers,
    body: requestBody,
  });

  const response = await _app.fetch(request, { relayBridged: true });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    let errorMessage: string;
    let errorDetails: unknown;
    let hasDetails = false;
    try {
      const parsed = JSON.parse(errorBody);
      errorMessage = parsed.error || parsed.message || `Route returned ${response.status}`;
      if (parsed.details !== undefined) {
        errorDetails = parsed.details;
        hasDetails = true;
      }
    } catch {
      errorMessage = errorBody || `Route returned ${response.status}`;
    }
    // Throw a real Error (so downstream `err instanceof Error` checks and
    // `.message` reads still work) with the HTTP status and structured
    // `details` attached as own properties. Before this, both fields were
    // dropped here and again in query-engine.handleMutate, leaving 409-recovery
    // branches in callers (e.g. `addRepoOrUseExisting`) dead.
    const routeError = new Error(errorMessage) as Error & {
      status?: number;
      details?: unknown;
    };
    routeError.status = response.status;
    if (hasDetails) routeError.details = errorDetails;
    throw routeError;
  }

  return response.json();
}
