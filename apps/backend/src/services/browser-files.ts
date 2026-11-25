import fs from "fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { fileUrl } from "@shared/api/files";
import type { InputOf } from "@shared/api/op";
import { AppError, ValidationError } from "../lib/errors";
import { loadWorkspace } from "../middleware/workspace-loader";
import { resolveWorkspaceRelativePath } from "./git.service";

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

function canonical(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch {
    return undefined;
  }
}

function resolveRecording(file: string) {
  if (!path.isAbsolute(file)) throw new ValidationError("path must be absolute");
  const real = canonical(file);
  if (!real) throw new AppError(404, "file not found");
  // On macOS tmpdir() and /tmp are different roots, and both can be symlinks.
  if (
    ![tmpdir(), "/tmp"].some((root) => {
      const resolved = canonical(root);
      return resolved && real.startsWith(resolved + path.sep);
    })
  )
    throw new AppError(403, "access denied");
  const type = recordings[path.extname(real).toLowerCase()];
  if (!type) throw new ValidationError("unsupported file type");
  const stat = fs.statSync(real, { throwIfNoEntry: false });
  if (!stat) throw new AppError(404, "file not found");
  if (!stat.isFile()) throw new ValidationError("not a file");
  return { realPath: real, source: { kind: "recording" as const, path: real }, stat, type };
}

function resolvePreview(id: string, file: string) {
  const { workspace, workspacePath } = loadWorkspace(id);
  if (!file) throw new ValidationError("path parameter is required");
  if (workspace.kind === "cloud" || !workspacePath)
    throw new ValidationError("This workspace's files are not on this computer");
  const relative = resolveWorkspaceRelativePath(workspacePath, file);
  if (!relative) throw new ValidationError("Invalid file path");
  const root = canonical(workspacePath);
  const real = canonical(path.join(workspacePath, relative));
  if (!root || !real) throw new ValidationError("File not found");
  const realRelative = path.relative(root, real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative))
    throw new ValidationError("Invalid file path");
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new ValidationError("Not a file");
  const type = previews[path.extname(real).toLowerCase()];
  if (!type) throw new ValidationError("Unsupported preview file type");
  return {
    realPath: real,
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
  const match = range?.match(/bytes=(\d+)-(\d*)/);
  if (!match)
    return { status: 200, start: 0, length: size, headers: { "Content-Length": String(size) } };
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (start >= size || end >= size || start > end)
    return { status: 416, headers: { "Content-Range": `bytes */${size}` } };
  const length = end - start + 1;
  return {
    status: 206,
    start,
    length,
    headers: { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(length) },
  };
}
