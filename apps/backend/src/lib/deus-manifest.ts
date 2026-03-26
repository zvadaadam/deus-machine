import { z } from "zod";

export type { NormalizedTask } from "@shared/types/manifest";

/**
 * Zod schemas for deus.json manifest.
 *
 * TaskEntry supports string shorthand ("bun run test") or full object form.
 * DeusManifest is the top-level schema — parsed with safeParse for graceful fallback.
 */

const TaskObjectSchema = z
  .object({
    command: z.string().min(1),
    description: z.string().optional(),
    icon: z.string().optional(),
    persistent: z.boolean().optional(),
    mode: z.enum(["concurrent", "nonconcurrent"]).optional(),
    depends: z.array(z.string()).optional(),
    platform: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const TaskEntrySchema = z.union([z.string().min(1), TaskObjectSchema]);

export const DeusManifestSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.number(),
    name: z.string().optional(),
    scripts: z
      .object({
        setup: z.string().optional(),
        run: z.string().optional(),
        archive: z.string().optional(),
      })
      .passthrough()
      .optional(),
    runScriptMode: z.enum(["concurrent", "nonconcurrent"]).optional(),
    requires: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    lifecycle: z
      .object({
        setup: z.string().optional(),
        archive: z.string().optional(),
      })
      .passthrough()
      .optional(),
    tasks: z.record(z.string(), TaskEntrySchema).optional(),
  })
  .passthrough();

export type DeusManifest = z.infer<typeof DeusManifestSchema>;
