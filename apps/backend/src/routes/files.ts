import { Hono } from "hono";
import fs from "fs";
import path from "node:path";
import { Readable } from "node:stream";
import { ValidationError } from "../lib/errors";
import { fileRange, resolveBrowserFile } from "../services/browser-files";

const app = new Hono();

function fileResponse(method: string, init: ResponseInit, open: () => fs.ReadStream): Response {
  if (method === "HEAD") return new Response(null, init);
  return new Response(Readable.toWeb(open()) as unknown as BodyInit, init);
}

app.get("/workspaces/:id/file-preview", (c) => {
  const { realPath, type, stat } = resolveBrowserFile({
    kind: "preview",
    workspaceId: c.req.param("id"),
    path: c.req.query("path") ?? "",
  });
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Content-Length": String(stat.size),
    "Content-Disposition": `inline; filename="${path.basename(realPath).replace(/"/g, "")}"`,
    "Cache-Control": "private, max-age=60",
  };
  // A repository's HTML gets an opaque origin so its scripts cannot read the backend.
  if (type.startsWith("text/html")) headers["Content-Security-Policy"] = "sandbox allow-scripts";
  return fileResponse(c.req.method, { headers }, () => fs.createReadStream(realPath));
});

app.get("/files/stream", (c) => {
  const file = c.req.query("path");
  if (!file) throw new ValidationError("path parameter is required");
  const { realPath, type, stat } = resolveBrowserFile({ kind: "recording", path: file });
  const range = fileRange(stat.size, c.req.method === "GET" ? c.req.header("range") : undefined);
  if (range.status === 416) return new Response(null, { status: 416, headers: range.headers });
  const init = {
    status: range.status,
    headers: {
      ...range.headers,
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    },
  };
  return fileResponse(c.req.method, init, () =>
    range.status === 206
      ? fs.createReadStream(realPath, { start: range.start, end: range.start + range.length - 1 })
      : fs.createReadStream(realPath)
  );
});

export default app;
