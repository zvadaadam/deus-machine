import { realpath, stat as fileStat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { fileUrl } from "@shared/api/files";
import type { InputOf } from "@shared/api/op";
import { AppError, ValidationError } from "../lib/errors";
import { loadWorkspace } from "../middleware/workspace-loader";
import { resolveWorkspaceFile } from "./files.service";

export type BrowserFileRequest = InputOf<typeof fileUrl>;

const recordings: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const previews: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".webp": "image/webp",
};

async function resolveRecording(file: string) {
  if (!path.isAbsolute(file)) throw new ValidationError("path must be absolute");
  // On macOS tmpdir() and /tmp are different roots, and both can be symlinks.
  const [real, ...roots] = await Promise.all(
    [file, tmpdir(), "/tmp"].map((name) => realpath(name).catch(() => null))
  );
  if (!real) throw new AppError(404, "file not found");
  if (!roots.some((root) => root && real.startsWith(root + path.sep)))
    throw new AppError(403, "access denied");
  const type = recordings[path.extname(real).toLowerCase()];
  if (!type) throw new ValidationError("unsupported file type");
  const stat = await fileStat(real).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") throw new AppError(404, "file not found");
    throw err;
  });
  if (!stat.isFile()) throw new ValidationError("not a file");
  return { realPath: real, source: { kind: "recording" as const, path: real }, stat, type };
}

async function resolvePreview(id: string, file: string) {
  const { workspace, workspacePath } = loadWorkspace(id);
  if (!file) throw new ValidationError("path parameter is required");
  if (workspace.kind === "cloud" || !workspacePath)
    throw new ValidationError("This workspace's files are not on this computer");
  const { realPath, realRelative } = await resolveWorkspaceFile(workspacePath, file);
  const stat = await fileStat(realPath);
  if (!stat.isFile()) throw new ValidationError("Not a file");
  const type = previews[path.extname(realPath).toLowerCase()];
  if (!type) throw new ValidationError("Unsupported preview file type");
  return {
    realPath,
    source: { kind: "preview" as const, workspaceId: id, path: realRelative },
    stat,
    type,
  };
}

/** The direct routes and the tunnel resolve the same real paths and allow the same files. */
export function resolveBrowserFile(input: BrowserFileRequest) {
  return input.kind === "recording"
    ? resolveRecording(input.path)
    : resolvePreview(input.workspaceId, input.path);
}

/** An unrecognized Range requests the full file. */
export function fileRange(
  size: number,
  range?: string
):
  | { status: 200 | 206; start: number; length: number; headers: Record<string, string> }
  | { status: 416; headers: Record<string, string> } {
  const match = range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!match)
    return { status: 200, start: 0, length: size, headers: { "Content-Length": String(size) } };
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end) return { status: 416, headers: { "Content-Range": `bytes */${size}` } };
  const length = end - start + 1;
  return {
    status: 206,
    start,
    length,
    headers: { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(length) },
  };
}
