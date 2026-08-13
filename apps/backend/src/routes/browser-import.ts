import { Hono } from "hono";
import {
  listBrowserProfiles,
  readProfileCookies,
  type BrowserId,
} from "../services/browser-import.service";
import { getClientIp, isLocalhost } from "../lib/network";

const app = new Hono();

// These routes return decrypted browser session cookies, so they must never be
// reachable from a remote paired device (which authMiddleware would otherwise
// admit with a bearer token). The feature is desktop-only — restrict to the
// local machine. Reads the same client IP the WebSocket route uses.
app.use("/browser/*", async (c, next) => {
  if (!isLocalhost(getClientIp(c))) {
    return c.json({ error: "Browser import is only available on the local device." }, 403);
  }
  await next();
});

/** List local Chromium browser profiles available to import. */
app.get("/browser/profiles", (c) => {
  return c.json({ profiles: listBrowserProfiles() });
});

/**
 * Read + decrypt cookies for one profile. Triggers a macOS Keychain prompt on
 * first access per browser. Returns cookies shaped for Electron cookie set;
 * the caller forwards them to the main process for injection.
 */
app.post("/browser/cookies", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    browserId?: string;
    profileDir?: string;
  };
  if (!body.browserId || !body.profileDir) {
    return c.json({ error: "browserId and profileDir are required" }, 400);
  }

  try {
    const cookies = await readProfileCookies(body.browserId as BrowserId, body.profileDir);
    return c.json({ cookies, count: cookies.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Keychain denial / cancel surfaces here — report it so the UI can explain.
    return c.json({ error: message }, 500);
  }
});

export default app;
