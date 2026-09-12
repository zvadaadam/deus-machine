/**
 * Unit tests for `route-delegate.ts`.
 *
 * `delegateToRoute` is the bridge between the WS q:mutate/q:request transport
 * and the existing Hono routes. On a non-2xx, it MUST preserve the HTTP
 * `status` and the route's structured `details` payload on the thrown `Error`
 * (as own properties) so `query-engine.handleMutate` can forward them on the
 * `q:mutate_result` failure frame and frontend callers can recover from
 * conflicts like a 409 "Repository already exists" by reusing the
 * already-registered entity.
 *
 * Before the fix, `delegateToRoute` threw `new Error(errorMessage)`, dropping
 * both fields — killing the 409-recovery branch in `addRepoOrUseExisting`.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { setApp, delegateToRoute } from "../../../src/services/route-delegate";

/** Capture a `delegateToRoute` rejection into a typed Error. The outer `as`
 *  is the assertion that narrows `unknown` (Promise<unknown> + .catch collapses
 *  back to unknown) into the structured Error shape produced by the fix. */
type RouteError = Error & { status?: number; details?: unknown };
async function captureRouteError(p: Promise<unknown>): Promise<RouteError> {
  return (await p.catch((e: unknown) => e)) as RouteError;
}

const existingRepo = {
  id: "repo-existing",
  name: "existing-repo",
  root_path: "/tmp/existing-repo",
  git_default_branch: "main",
  sort_order: 1,
};

function buildApp(): Hono {
  const app = new Hono();
  // Mirrors the real /api/repos 409 shape from `error-handler.ts`:
  //   { error: "...", details: <existing row> }
  app.post("/api/repos", (c) =>
    c.json({ error: "Repository already exists", details: existingRepo }, 409)
  );
  // 404 with an `error` message but no `details`.
  app.get("/api/missing", (c) => c.json({ error: "Not found" }, 404));
  // 500 with a non-JSON body — exercises the JSON.parse fallback.
  app.get("/api/broken", (c) => c.text("internal broken", 500));
  // 422 with nested structured details (Validator-style).
  app.get("/api/validation", (c) =>
    c.json({ error: "Bad input", details: { field: "name" } }, 422)
  );
  // 2xx success.
  app.get("/api/ok", (c) => c.json({ ok: true }));
  return app;
}

describe("delegateToRoute — non-2xx preservation", () => {
  beforeAll(() => {
    setApp(buildApp());
  });

  it("throws an Error carrying the HTTP status and the route's `details` on a 409", async () => {
    const err = await captureRouteError(
      delegateToRoute("POST", "/api/repos", { root_path: "/tmp/existing-repo" })
    );

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Repository already exists");
    expect(err.status).toBe(409);
    expect(err.details).toEqual(existingRepo);
  });

  it("throws an Error carrying the status even when the body has no `details`", async () => {
    const err = await captureRouteError(delegateToRoute("GET", "/api/missing"));

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Not found");
    expect(err.status).toBe(404);
    // No `details` in the body → no `details` attached.
    expect(err.details).toBeUndefined();
  });

  it("throws an Error with a fallback message and the status when the body is not JSON", async () => {
    const err = await captureRouteError(delegateToRoute("GET", "/api/broken"));

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("internal broken");
    expect(err.status).toBe(500);
    expect(err.details).toBeUndefined();
  });

  it("preserves nested structured details (e.g. validator field errors)", async () => {
    const err = await captureRouteError(delegateToRoute("GET", "/api/validation"));

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Bad input");
    expect(err.status).toBe(422);
    expect(err.details).toEqual({ field: "name" });
  });

  it("returns the parsed JSON body unchanged on 2xx", async () => {
    const data = await delegateToRoute("GET", "/api/ok");
    expect(data).toEqual({ ok: true });
  });
});
