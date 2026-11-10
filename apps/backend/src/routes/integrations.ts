import { Hono } from "hono";
import { getErrorMessage } from "@shared/lib/errors";
import {
  completeCloudCallback,
  completeOAuthCallback,
  GATEWAY_PATH,
  isGatewayKey,
  proxyMcp,
  SIGN_IN_CALLBACK_PATH,
} from "../services/integrations";
import { isLocalhost, getClientIp } from "../lib/network";

// The two things about Customize that are plain HTTP: the page a sign-in
// returns to, and the gateway agents' MCP clients call. Everything the app's
// own UI reads or changes goes over the WebSocket (q:subscribe / q:request /
// q:mutate), not through here.

const app = new Hono();
/** This router is mounted at `/api`. */
const CALLBACK = SIGN_IN_CALLBACK_PATH.replace(/^\/api/, "");

/**
 * Where an app's OAuth sign-in returns, in the user's own browser. The
 * `state` it carries is single-use and unguessable; the page closes itself
 * and the app's card updates over the WebSocket.
 */
app.get(CALLBACK, async (c) => {
  const params = new URL(c.req.url).searchParams;
  try {
    const appName = await completeOAuthCallback(params);
    return c.html(
      resultPage(`${appName} is connected`, "You can close this tab and return to Deus.")
    );
  } catch (error) {
    return c.html(resultPage("Couldn't connect", getErrorMessage(error)), 400);
  }
});

/**
 * Where a broker's sign-in page returns (an app connected through Deus
 * Cloud). The address itself is the attempt: unguessable, and all it can do
 * is make Deus ask Deus Cloud whether that sign-in finished.
 */
app.get(`${CALLBACK}/:attempt`, async (c) => {
  try {
    const appName = await completeCloudCallback(c.req.param("attempt"));
    return c.html(
      resultPage(`${appName} is connected`, "You can close this tab and return to Deus.")
    );
  } catch (error) {
    return c.html(resultPage("Couldn't connect", getErrorMessage(error)), 400);
  }
});

/**
 * The gateway: an agent on this computer reaches an app's MCP server through
 * here, and the account's credential is attached on the way out. Only this
 * computer, and only with the key a turn's config carries (so a web page that
 * finds the port cannot use the user's accounts).
 */
app.all(`${GATEWAY_PATH.replace(/^\/api/, "")}/:appId`, async (c) => {
  if (!isLocalhost(getClientIp(c)) || !isGatewayKey(c.req.header("authorization"))) {
    return c.text("Forbidden", 403);
  }
  return proxyMcp(c.req.param("appId"), c.req.raw);
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** A standalone page in the browser, outside the app's stylesheet. */
function resultPage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Deus</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { max-width: 360px; padding: 24px; text-align: center; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
  p { font-size: 13px; line-height: 1.5; margin: 0; opacity: 0.65; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main>
<script>setTimeout(function () { window.close(); }, 1200);</script>
</body></html>`;
}

export default app;
