import { Hono } from "hono";
import { readWorkspace } from "../api/workspaces";

const app = new Hono();

// The desktop shell asks where a workspace's files are (main/native-handlers.ts).
// Everything else about workspaces is an operation: see api/workspaces.ts.
app.get("/workspaces/:id", (c) => c.json(readWorkspace(c.req.param("id"))));

export default app;
