import { Hono } from "hono";
import fs from "fs";
import path from "node:path";
import { Readable } from "node:stream";
import { ValidationError } from "../lib/errors";
import { fileRange, resolveBrowserFile } from "../services/browser-files";

const app = new Hono();
const toResponseBody = (stream: fs.ReadStream): BodyInit =>
  Readable.toWeb(stream) as unknown as BodyInit;

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
  return new Response(toResponseBody(fs.createReadStream(realPath)), { headers });
});

app.get("/files/stream", (c) => {
  const file = c.req.query("path");
  if (!file) throw new ValidationError("path parameter is required");
  const { realPath, type, stat } = resolveBrowserFile({ kind: "recording", path: file });
  const range = fileRange(stat.size, c.req.method === "GET" ? c.req.header("range") : undefined);
  if (range.status === 416) return new Response(null, { status: 416, headers: range.headers });
  const stream =
    range.status === 206
      ? fs.createReadStream(realPath, { start: range.start, end: range.start + range.length - 1 })
      : fs.createReadStream(realPath);
  return new Response(toResponseBody(stream), {
    status: range.status,
    headers: {
      ...range.headers,
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    },
  });
});

export default app;
