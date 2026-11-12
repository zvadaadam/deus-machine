import { Hono } from "hono";

// No routes: agent configuration is read and written through the `agentConfig`
// operations (api/settings.ts). The file stays until app.ts stops mounting it.
const app = new Hono();

export default app;
