/**
 * Custom worker entry for deusmachine.ai — the root-domain edge router.
 *
 * Wraps TanStack Start's default server entry (which renders the landing) with
 * the root split: landing-owned requests go to Start, everything else is
 * proxied to the deus web app's Pages deployment. See `worker-routing.ts` for
 * the ownership rules and `apps/web` for the app's side of the contract
 * (`app-assets` prefix, `_redirects` alias of app.deusmachine.ai).
 *
 * In dev (`vite dev`) the proxy is disabled — the local landing has no
 * business fetching the production app, and Vite's own request surface (HMR,
 * transformed modules) must all reach Start.
 */
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { decideRootRequest } from "./worker-routing";

interface Env {
  /** Origin of the deus web app deployment (the Pages project). */
  APP_ORIGIN?: string;
}

const startFetch = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);
    const proxyEnabled = !import.meta.env.DEV;
    const destination = proxyEnabled
      ? decideRootRequest(url.pathname, request.headers.get("cookie"))
      : "landing";

    if (destination === "app") {
      const target = new URL(url.pathname + url.search, env.APP_ORIGIN ?? "https://deus.pages.dev");
      return fetch(new Request(target.toString(), request));
    }

    return (startFetch as (req: Request, env: unknown, ctx: unknown) => Promise<Response>)(
      request,
      env,
      ctx
    );
  },
};
