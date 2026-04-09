import { Hono } from "hono";
import { listRecentProjects } from "../services/recent-projects.service";

const app = new Hono();

app.get("/onboarding/recent-projects", (c) => {
  return c.json({ projects: listRecentProjects() });
});

export default app;
