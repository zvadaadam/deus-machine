import { Hono, type Context } from "hono";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { parseBody } from "../lib/schemas";
import { getDeusCloudSessionConfig } from "../services/agent/cloud/config";

const app = new Hono();
const accountPath = "/me/provider-accounts";
const label = z.string().trim().min(1).max(80).optional();
const connectionFields = {
  provider: z.enum(["claude", "codex"]),
  label,
  replaceAccountId: z.string().min(1).optional(),
};
const loginBody = z.object(connectionFields).strict();
const secretBody = z
  .object({
    ...connectionFields,
    authMethod: z.enum(["api_key", "subscription"]),
    secret: z.string().trim().min(1).max(32768),
  })
  .strict();
const updateBody = z.object({ label, isDefault: z.literal(true).optional() }).strict();

/** Fixed cloud routes only. The renderer never receives the desktop's WorkOS bearer. */
async function forward(c: Context, path: string, body?: unknown): Promise<Response> {
  const config = getDeusCloudSessionConfig();
  if (!config?.deusCloudSessionToken || !config.deusCloudUrl) {
    throw new AppError(401, "Sign in to Deus Cloud to manage your provider accounts.");
  }
  let response: Response;
  try {
    response = await fetch(`${config.deusCloudUrl.replace(/\/$/, "")}${path}`, {
      method: c.req.method,
      headers: {
        authorization: `Bearer ${config.deusCloudSessionToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: c.req.raw.signal,
      redirect: "manual",
    });
  } catch (error) {
    if (c.req.raw.signal.aborted) throw error;
    throw new AppError(502, "Couldn't reach Deus Cloud. Try again.");
  }
  // Forward the body as a stream. Buffering it would hide the device-login result,
  // and forwarding arbitrary upstream headers could expose cookies or redirects.
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}

app.get("/settings/provider-accounts", (c) => forward(c, accountPath));
app.post("/settings/provider-accounts", async (c) =>
  forward(c, accountPath, parseBody(secretBody, await c.req.json()))
);
app.post("/settings/provider-accounts/logins", async (c) =>
  forward(c, `${accountPath}/logins`, parseBody(loginBody, await c.req.json()))
);
app.get("/settings/provider-accounts/logins/:loginId/events", (c) =>
  forward(c, `${accountPath}/logins/${encodeURIComponent(c.req.param("loginId"))}/events`)
);
app.delete("/settings/provider-accounts/logins/:loginId", (c) =>
  forward(c, `${accountPath}/logins/${encodeURIComponent(c.req.param("loginId"))}`)
);
app.patch("/settings/provider-accounts/:id", async (c) =>
  forward(
    c,
    `${accountPath}/${encodeURIComponent(c.req.param("id"))}`,
    parseBody(updateBody, await c.req.json())
  )
);
app.delete("/settings/provider-accounts/:id", (c) =>
  forward(c, `${accountPath}/${encodeURIComponent(c.req.param("id"))}`)
);

export default app;
