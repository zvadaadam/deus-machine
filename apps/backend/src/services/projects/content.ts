import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProjectFile } from "@shared/projects";
import { ValidationError } from "../../lib/errors";

export type ContentManifest = Record<string, ProjectFile>;
export const MAX_FILE_BYTES = 256 * 1024;

/** A single authority for published bytes. Runtime copies are disposable drafts. */
export class ProjectContent {
  constructor(private readonly root: string) {}

  validatePath(value: string): string {
    if (
      !value ||
      value.length > 240 ||
      value.includes("\\") ||
      value.startsWith("/") ||
      value.split("/").some((part) => !part || part === "." || part === "..") ||
      Array.from(value).some((character) => character.charCodeAt(0) < 32)
    ) {
      throw new ValidationError("Use a relative Project file path without '..'.");
    }
    return value;
  }

  write(filePath: string, content: string): ProjectFile {
    this.validatePath(filePath);
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > MAX_FILE_BYTES)
      throw new ValidationError("Project files must be under 256 KB.");
    const hash = createHash("sha256").update(bytes).digest("hex");
    fs.mkdirSync(this.root, { recursive: true });
    const destination = path.join(this.root, hash);
    const temporary = path.join(this.root, `.pending-${randomUUID()}`);
    try {
      const file = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(file, bytes);
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
      try {
        // Only complete bytes can acquire their immutable name. Concurrent
        // publishers reuse the existing blob without overwriting it.
        fs.linkSync(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (createHash("sha256").update(fs.readFileSync(destination)).digest("hex") !== hash) {
          throw new Error("Published Project content failed its integrity check.");
        }
      }
      const directory = fs.openSync(this.root, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return { path: filePath, hash, size: bytes.length };
  }

  read(file: ProjectFile): string {
    if (!/^[a-f0-9]{64}$/.test(file.hash)) throw new Error("Invalid Project content reference.");
    const bytes = fs.readFileSync(path.join(this.root, file.hash));
    if (createHash("sha256").update(bytes).digest("hex") !== file.hash) {
      throw new Error("Published Project content failed its integrity check.");
    }
    return bytes.toString("utf8");
  }
}
