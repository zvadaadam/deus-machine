import { Hono } from "hono";
import * as api from "@shared/api/repos";
import { addRepository } from "../api/repos";
import { getDatabase } from "../lib/database";
import { getCloudEnvironmentInfo } from "../services/cloud-environment.service";
import { NotFoundError } from "../lib/errors";
import { parseBody } from "../lib/schemas";
import { getRepositoryById } from "../db";

const app = new Hono();

// A script with no socket registers its repository here
// (test/e2e/project-environment.runtime.mjs). Everything else about
// repositories is an operation: see api/repos.ts.
app.post("/repos", async (c) => {
  const { root_path } = parseBody(api.addRepo.input, await c.req.json());
  return c.json(addRepository(root_path), 201);
});

// Does this repo have a specialized cloud environment on the platform?
// Drives the "Set up cloud environment" quick action in cloud workspaces.
app.get("/repos/:id/cloud-environment", async (c) => {
  const db = getDatabase();
  const repo = getRepositoryById(db, c.req.param("id"));
  if (!repo) throw new NotFoundError("Repository not found");
  if (!repo.git_origin_url) return c.json({ configured: false, name: null });
  return c.json(await getCloudEnvironmentInfo(repo.git_origin_url));
});

export default app;
