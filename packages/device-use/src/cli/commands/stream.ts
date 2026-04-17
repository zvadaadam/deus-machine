import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import { resolveCommandSetup } from "../runtime.js";
import { streamDisable, streamEnable, streamStatus } from "../stream/manager.js";

const schema = z.object({
  _positionals: z.array(z.string()).optional(),
  port: z.coerce.number().optional(),
  p: z.coerce.number().optional(),
});

type Params = z.infer<typeof schema>;

export const streamCommand: CommandDefinition<Params> = {
  name: "stream",
  description: "Stream simulator screen (enable|disable|status)",
  usage: "stream <enable|disable|status> [--port 3100]",
  examples: ["stream enable", "stream enable --port 8080", "stream status", "stream disable"],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const subcommand = params._positionals?.[0] ?? "status";

    switch (subcommand) {
      case "enable": {
        const setup = await resolveCommandSetup(ctx);
        if (!("udid" in setup)) return setup;

        const port = params.port ?? params.p ?? 3100;

        try {
          const result = await streamEnable(setup.udid, port, {
            startupTimeoutMs: ctx.flags.timeoutMs,
          });
          const ttyLines = [
            `Stream:  ${result.url}/stream.mjpeg`,
            `Viewer:  ${result.viewerUrl}`,
            `  Open it in a browser: open ${JSON.stringify(result.viewerUrl)}`,
          ].join("\n");
          return {
            success: true,
            message: result.message ?? `Streaming on port ${result.port}`,
            data: ctx.flags.json
              ? {
                  port: result.port,
                  url: result.url,
                  streamUrl: `${result.url}/stream.mjpeg`,
                  viewerUrl: result.viewerUrl,
                  viewerFile: result.viewerFile,
                }
              : ttyLines,
            nextSteps: [
              { command: "stream status", label: "Check status" },
              { command: "stream disable", label: "Stop streaming" },
            ],
          };
        } catch (err) {
          return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }

      case "disable": {
        const result = streamDisable();
        return { success: result.success, message: result.message };
      }

      case "status": {
        const status = streamStatus();
        if (!status.enabled) {
          return {
            success: true,
            message: "No stream server running",
            data: ctx.flags.json ? { enabled: false } : undefined,
            nextSteps: [{ command: "stream enable", label: "Start streaming" }],
          };
        }
        const ttyLines = [
          `Port:    ${status.port} (PID ${status.pid})`,
          `Stream:  ${status.url}/stream.mjpeg`,
          status.viewerUrl ? `Viewer:  ${status.viewerUrl}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          success: true,
          message: `Streaming on port ${status.port} (PID: ${status.pid})`,
          data: ctx.flags.json ? status : ttyLines,
          nextSteps: [{ command: "stream disable", label: "Stop streaming" }],
        };
      }

      default:
        return {
          success: false,
          message: `Unknown subcommand: ${subcommand}. Use: enable, disable, or status`,
        };
    }
  },
};
