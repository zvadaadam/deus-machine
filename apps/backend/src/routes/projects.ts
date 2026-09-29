import { Hono } from "hono";
import { z } from "zod";
import { ValidationError } from "../lib/errors";
import {
  createProject,
  getProject,
  listProjects,
  sendProjectInput,
  controlProject,
  readProjectFile,
  publishProjectFile,
} from "../services/projects/service";

const routes = new Hono();
const RequestId = z.string().min(1).max(160);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ValidationError("Invalid Project request.", result.error.flatten());
  return result.data;
}
routes.get("/projects", (c) => c.json(listProjects()));
routes.post("/projects", async (c) => c.json(await createProject(await c.req.json()), 201));
routes.get("/projects/:id", (c) => c.json(getProject(c.req.param("id"))));
routes.post("/projects/:id/message", async (c) => {
  const body = parse(
    z.object({
      requestId: RequestId,
      message: z.string().trim().min(1).max(32000),
      agentId: z.string().optional(),
    }),
    await c.req.json()
  );
  return c.json(sendProjectInput(c.req.param("id"), body), 202);
});
for (const action of ["pause", "resume", "archive"] as const) {
  routes.post(`/projects/:id/${action}`, async (c) => {
    const body = parse(z.object({ requestId: RequestId }), await c.req.json());
    return c.json(controlProject(c.req.param("id"), action, body.requestId));
  });
}
routes.post("/projects/:id/inputs/:inputId/cancel", async (c) => {
  const body = parse(z.object({ requestId: RequestId }), await c.req.json());
  return c.json(
    controlProject(c.req.param("id"), "cancel_input", body.requestId, {
      inputId: c.req.param("inputId"),
    })
  );
});
routes.post("/projects/:id/agents/:agentId/stop", async (c) => {
  const body = parse(z.object({ requestId: RequestId }), await c.req.json());
  return c.json(
    controlProject(c.req.param("id"), "stop", body.requestId, { agentId: c.req.param("agentId") })
  );
});
routes.post("/projects/:id/agents/:agentId/resume", async (c) => {
  const body = parse(z.object({ requestId: RequestId }), await c.req.json());
  return c.json(
    controlProject(c.req.param("id"), "resume_agent", body.requestId, {
      agentId: c.req.param("agentId"),
    })
  );
});
routes.post("/projects/:id/agents/:agentId/retry", async (c) => {
  const body = parse(z.object({ requestId: RequestId }), await c.req.json());
  return c.json(
    controlProject(c.req.param("id"), "retry", body.requestId, { agentId: c.req.param("agentId") })
  );
});
routes.post("/projects/:id/reports/:reportId/accept", async (c) => {
  const body = parse(z.object({ requestId: RequestId }), await c.req.json());
  return c.json(
    controlProject(c.req.param("id"), "accept", body.requestId, {
      reportId: c.req.param("reportId"),
    })
  );
});
routes.post("/projects/:id/limits", async (c) => {
  const body = parse(
    z.object({ requestId: RequestId, dispatchLimit: z.number().int().min(1).max(1000) }),
    await c.req.json()
  );
  return c.json(
    controlProject(c.req.param("id"), "limits", body.requestId, {
      dispatchLimit: body.dispatchLimit,
    })
  );
});
routes.get("/projects/:id/files", (c) => {
  const revision = c.req.query("revision");
  if (
    revision !== undefined &&
    (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)))
  )
    throw new ValidationError("Invalid content revision.");
  return c.json(
    readProjectFile(
      c.req.param("id"),
      c.req.query("path") ?? "",
      revision === undefined ? undefined : Number(revision)
    )
  );
});
routes.post("/projects/:id/content", async (c) => {
  const body = parse(
    z.object({
      requestId: RequestId,
      path: z.string().min(1).max(240),
      content: z.string().max(256 * 1024),
      expectedRevision: z.number().int().min(0),
    }),
    await c.req.json()
  );
  return c.json(publishProjectFile(c.req.param("id"), body));
});
export default routes;
