import { Hono } from "hono";
import path from "path";
import fs from "fs";
import os from "os";
import { spawn } from "child_process";
import { withWorkspace } from "../middleware/workspace-loader";
import { ValidationError, NotFoundError } from "../lib/errors";
import { parseBody, OpenPenFileBody } from "../lib/schemas";
import * as gitService from "../services/git.service";
import type { WorkspaceWithDetailsRow } from "../db";

type Env = { Variables: { workspace: WorkspaceWithDetailsRow; workspacePath: string } };
const app = new Hono<Env>();

// Pen files
app.get("/workspaces/:id/pen-files", withWorkspace, (c) => {
  const workspacePath = c.get("workspacePath");
  const MAX_DEPTH = 10;
  const MAX_FILES = 500;

  function findPenFiles(
    dirPath: string,
    relativeTo: string,
    depth = 0,
    results: any[] = []
  ): any[] {
    if (depth > MAX_DEPTH || results.length >= MAX_FILES) return results;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          findPenFiles(fullPath, relativeTo, depth + 1, results);
        } else if (entry.isFile() && entry.name.endsWith(".pen")) {
          results.push({ name: entry.name, path: path.relative(relativeTo, fullPath) });
          if (results.length >= MAX_FILES) return results;
        }
      }
    } catch {}
    return results;
  }

  const files = findPenFiles(workspacePath, workspacePath);
  return c.json({ files, count: files.length });
});

// Open pen file
app.post("/workspaces/:id/open-pen-file", withWorkspace, async (c) => {
  const { filePath } = parseBody(OpenPenFileBody, await c.req.json());

  const workspacePath = c.get("workspacePath");
  const safeRelativePath = gitService.resolveWorkspaceRelativePath(workspacePath, filePath);
  if (!safeRelativePath) throw new ValidationError("Invalid file path");

  const absolutePath = path.resolve(workspacePath, safeRelativePath);
  if (!fs.existsSync(absolutePath)) throw new NotFoundError("File not found");
  if (!absolutePath.endsWith(".pen")) throw new ValidationError("File must have .pen extension");
  const fileStats = fs.statSync(absolutePath);
  if (!fileStats.isFile()) throw new NotFoundError("Target is not a file");

  const envPencilApp = process.env.PENCIL_APP_NAME || process.env.PENCIL_APP;
  const pencilCandidates = [
    envPencilApp,
    "/Applications/Pencil.app",
    path.join(os.homedir(), "Applications", "Pencil.app"),
    "Pencil",
  ].filter(Boolean) as string[];

  let pencilApp: string | null = null;
  for (const candidate of pencilCandidates) {
    if (candidate.endsWith(".app") || candidate.startsWith("/")) {
      if (fs.existsSync(candidate)) {
        pencilApp = candidate;
        break;
      }
    } else {
      pencilApp = candidate;
      break;
    }
  }

  if (process.platform === "darwin" && pencilApp) {
    const child = spawn("open", ["-a", pencilApp, absolutePath], { stdio: "ignore" });
    let didFallback = false;
    const fallbackToWeb = () => {
      if (didFallback) return;
      didFallback = true;
      const { cmd, args } = gitService.getOpenCommand("https://pencil.dev");
      const webChild = spawn(cmd, args, { stdio: "ignore" });
      webChild.on("error", (err) => console.error("[workspaces.design] Failed to open web fallback:", err));
      webChild.unref();
    };
    child.on("error", fallbackToWeb);
    child.on("exit", (code) => {
      if (code !== 0) fallbackToWeb();
    });
    child.unref();
  } else {
    const { cmd, args } = gitService.getOpenCommand("https://pencil.dev");
    const webChild = spawn(cmd, args, { stdio: "ignore" });
    webChild.on("error", (err) => console.error("[workspaces.design] Failed to open web fallback:", err));
    webChild.unref();
  }

  return c.json({ success: true });
});

export default app;
