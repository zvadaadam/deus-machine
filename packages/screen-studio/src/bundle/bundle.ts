import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { ScreenStudioError } from "../errors.js";
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  BundleEventSchema,
  ManifestSchema,
  type BundleEvent,
  type EventInput,
  type Manifest,
} from "./schema.js";

export const BUNDLE_FILES = {
  manifest: "manifest.json",
  events: "events.jsonl",
  media: "media",
  analysis: "analysis",
  renders: "renders",
  logs: "logs",
} as const;

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export function ownerToken(): string {
  return randomBytes(8).toString("hex");
}

export function currentOwner(
  kind: "worker" | "host" = "host",
  pid = process.pid
): NonNullable<Manifest["capture"]["owner"]> {
  return { pid, hostname: hostname(), token: ownerToken(), kind, childPids: [] };
}

/**
 * Create an empty bundle directory. Refuses a directory that already holds
 * anything, so a retried command can never overwrite an earlier recording.
 */
export async function createBundle(
  dir: string,
  init: Pick<Manifest, "source" | "capture"> & { id?: string }
): Promise<Manifest> {
  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  const existing = await readdir(root);
  if (existing.length > 0) {
    throw new ScreenStudioError("bundle_exists", `${root} is not empty`, {
      hint: "Choose a new output directory; recordings are never overwritten.",
    });
  }
  await mkdir(join(root, BUNDLE_FILES.media));
  await mkdir(join(root, BUNDLE_FILES.logs));
  const manifest: Manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    id: init.id ?? newId("rec"),
    createdAt: new Date().toISOString(),
    status: "starting",
    source: init.source,
    capture: init.capture,
  };
  await writeManifest(root, manifest);
  await writeFile(join(root, BUNDLE_FILES.events), "");
  return manifest;
}

export async function readManifest(dir: string): Promise<Manifest> {
  const path = join(resolve(dir), BUNDLE_FILES.manifest);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ScreenStudioError("bundle_not_found", `No recording bundle at ${resolve(dir)}`, {
        hint: "Pass the directory given to `start --out` (it contains manifest.json).",
      });
    }
    throw err;
  }
  const parsed = ManifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new ScreenStudioError(
      "bundle_invalid",
      `Invalid manifest: ${parsed.error.issues[0]?.message}`,
      {
        details: { issues: parsed.error.issues.slice(0, 5) },
      }
    );
  }
  return parsed.data;
}

/** Atomic replace: readers never observe a half-written manifest. */
export async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  const path = join(resolve(dir), BUNDLE_FILES.manifest);
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(tmp, path);
}

export async function updateManifest(
  dir: string,
  update: (manifest: Manifest) => Manifest | void
): Promise<Manifest> {
  const current = await readManifest(dir);
  const next = update(current) ?? current;
  await writeManifest(dir, next);
  return next;
}

/** Validate and stamp an event without writing it. */
export function makeEvent(input: EventInput, by?: string): BundleEvent {
  const candidate = {
    ...input,
    id: input.id ?? newId("ev"),
    at: input.at ?? Date.now(),
    ...(by && !input.by ? { by } : {}),
  };
  const parsed = BundleEventSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ScreenStudioError(
      "invalid_argument",
      `Invalid ${input.kind ?? "event"}: ${issue?.path.join(".") || "event"} ${issue?.message}`
    );
  }
  return parsed.data;
}

/**
 * Append events with one O_APPEND write per batch. Any process may append while
 * the recorder owns the manifest, which keeps CLI calls lock-free.
 */
export async function appendEvents(dir: string, events: BundleEvent[]): Promise<void> {
  if (events.length === 0) return;
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(join(resolve(dir), BUNDLE_FILES.events), lines);
}

export async function readEvents(dir: string): Promise<{ events: BundleEvent[]; skipped: number }> {
  let raw = "";
  try {
    raw = await readFile(join(resolve(dir), BUNDLE_FILES.events), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const events: BundleEvent[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = BundleEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) events.push(parsed.data);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  events.sort((a, b) => a.at - b.at);
  return { events, skipped };
}

export function bundlePath(dir: string, ...parts: string[]): string {
  return join(resolve(dir), ...parts);
}
