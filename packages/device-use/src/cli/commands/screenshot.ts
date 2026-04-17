import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import { takeScreenshot } from "../../engine/simctl.js";
import { resolveCommandSetup } from "../runtime.js";
import { annotateScreenshot } from "./annotate.js";

const schema = z.object({
  format: z.enum(["png", "jpeg"]).optional(),
  base64: z.boolean().optional(),
  annotate: z.boolean().optional(),
  _positionals: z.array(z.string()).optional(),
});

type Params = z.infer<typeof schema>;

export const screenshotCommand: CommandDefinition<Params> = {
  name: "screenshot",
  description: "Capture a screenshot (optionally annotated with @ref boxes)",
  usage: "screenshot [file] [--format png|jpeg] [--base64] [--annotate]",
  examples: [
    "screenshot",
    "screenshot login.png",
    "screenshot --format jpeg --base64",
    "screenshot debug.png --annotate",
  ],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;
    const { udid: resolved, store } = setup;

    const outputFile = params._positionals?.[0];
    const format = params.format ?? "png";
    const wantBase64 = params.base64 || ctx.flags.json;
    const wantAnnotate = params.annotate;

    const targetPath = outputFile
      ? resolve(outputFile)
      : join(tmpdir(), `device-use-${Date.now()}.${format}`);

    // --- Capture (maybe to temp; we may overwrite with annotated version) ---
    const rawPath = wantAnnotate
      ? join(tmpdir(), `device-use-raw-${Date.now()}.${format}`)
      : targetPath;
    await takeScreenshot(ctx.executor, resolved, rawPath, { format });

    let annotate: Awaited<ReturnType<typeof annotateScreenshot>> | undefined;
    let warnings: string[] | undefined;

    if (wantAnnotate) {
      if (format === "jpeg") {
        warnings = ["--annotate only supports png; use --format png or the default"];
      } else {
        const refs = store.getAllRefs();
        if (refs.length === 0) {
          warnings = [
            "No @refs in session — run `device-use snapshot` first, then re-run --annotate",
          ];
        } else {
          annotate = await annotateScreenshot(rawPath, refs, targetPath);
        }
      }
      // If we didn't annotate for any reason, fall back to using the raw capture.
      if (!annotate) {
        const { cpSync, unlinkSync } = await import("node:fs");
        cpSync(rawPath, targetPath);
        try {
          unlinkSync(rawPath);
        } catch {
          /* ignore */
        }
      } else {
        try {
          const { unlinkSync } = await import("node:fs");
          unlinkSync(rawPath);
        } catch {
          /* ignore */
        }
      }
    }

    // --- Response shaping ---
    const baseData: Record<string, unknown> = { path: targetPath };
    if (annotate) {
      baseData.annotated = true;
      baseData.imageSize = { width: annotate.width, height: annotate.height };
      baseData.scale = annotate.scale;
      baseData.boxes = annotate.boxes;
    }

    const msg = outputFile
      ? annotate
        ? `Screenshot saved to ${targetPath} with ${annotate.boxes.length} annotated @refs`
        : `Screenshot saved to ${targetPath}`
      : "Screenshot captured";

    if (wantBase64 && !outputFile) {
      const buffer = readFileSync(targetPath);
      const base64 = buffer.toString("base64");
      return {
        success: true,
        message: msg,
        data: ctx.flags.json ? { ...baseData, base64, format } : base64,
        ...(warnings ? { warnings } : {}),
      };
    }

    return {
      success: true,
      message: outputFile ? msg : `Screenshot saved to ${targetPath}`,
      data: baseData,
      ...(warnings ? { warnings } : {}),
    };
  },
};
