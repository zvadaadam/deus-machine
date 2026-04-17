import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import {
  waitForLabel,
  waitForId,
  waitForType,
  type WaitForOptions,
} from "../../engine/wait-for.js";
import { ValidationError } from "../../engine/errors.js";
import { resolveCommandSetup } from "../runtime.js";

const schema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  type: z.string().optional(),
  timeout: z.coerce.number().optional(),
  interval: z.coerce.number().optional(),
  gone: z.boolean().optional(),
  _positionals: z.array(z.string()).optional(),
});

type Params = z.infer<typeof schema>;

export const waitForCommand: CommandDefinition<Params> = {
  name: "wait-for",
  aliases: ["wait"],
  description: "Wait for an element to appear (or disappear) in the UI",
  usage:
    "wait-for <--label <text> | --id <id> | --type <type>> [--timeout 10] [--interval 0.5] [--gone]",
  examples: [
    'wait-for --label "Sign In"',
    'wait-for --id "loadingSpinner" --gone',
    'wait-for --type "Button" --timeout 15',
  ],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;
    const { udid: resolved, simBridgeOptions } = setup;

    const waitOpts: WaitForOptions = {
      timeoutMs: (params.timeout ?? 10) * 1000,
      intervalMs: (params.interval ?? 0.5) * 1000,
      waitForRemoval: params.gone,
      ...simBridgeOptions,
    };

    let result;
    let description: string;

    if (params.label) {
      description = `label="${params.label}"`;
      result = await waitForLabel(resolved, params.label, waitOpts);
    } else if (params.id) {
      description = `id="${params.id}"`;
      result = await waitForId(resolved, params.id, waitOpts);
    } else if (params.type) {
      description = `type="${params.type}"`;
      result = await waitForType(resolved, params.type, waitOpts);
    } else {
      throw new ValidationError("Provide --label, --id, or --type to match against");
    }

    const action = params.gone ? "disappear" : "appear";

    if (result.found) {
      return {
        success: true,
        message: `Element ${description} ${params.gone ? "disappeared" : "found"} after ${result.elapsedMs}ms (${result.attempts} poll${result.attempts === 1 ? "" : "s"})`,
        data: ctx.flags.json
          ? {
              found: true,
              element: result.element ?? null,
              elapsedMs: result.elapsedMs,
              attempts: result.attempts,
            }
          : undefined,
        nextSteps: [
          { command: "snapshot -i", label: "Take snapshot" },
          { command: "screenshot", label: "Take screenshot" },
        ],
      };
    }

    return {
      success: false,
      message: `Timed out waiting for ${description} to ${action} after ${result.elapsedMs}ms (${result.attempts} poll${result.attempts === 1 ? "" : "s"})`,
      data: ctx.flags.json
        ? {
            found: false,
            elapsedMs: result.elapsedMs,
            attempts: result.attempts,
          }
        : undefined,
    };
  },
};
