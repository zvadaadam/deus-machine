import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import * as interaction from "../../engine/interaction.js";
import { ValidationError } from "../../engine/errors.js";
import { resolveCommandSetup } from "../runtime.js";

const schema = z.object({
  _positionals: z.array(z.string()).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  duration: z.coerce.number().optional(),
});

type Params = z.infer<typeof schema>;

function parsePoint(s: string | undefined, label: string): { x: number; y: number } {
  if (!s) throw new ValidationError(`Missing ${label} — expected "x,y"`);
  const match = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) throw new ValidationError(`Invalid ${label} "${s}" — expected "x,y"`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

export const swipeCommand: CommandDefinition<Params> = {
  name: "swipe",
  description: "Swipe from one point to another (coordinates in logical points)",
  usage: "swipe --from x,y --to x,y [--duration SECONDS]",
  examples: [
    "swipe --from 200,400 --to 200,100",
    "swipe --from 100,500 --to 300,500 --duration 0.3",
    "swipe 200,400 200,100               # positional form",
  ],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;

    // Accept flag form (--from x,y --to x,y) OR positional form (swipe "x,y" "x,y").
    const positionals = params._positionals ?? [];
    const fromStr = params.from ?? positionals[0];
    const toStr = params.to ?? positionals[1];

    const from = parsePoint(fromStr, "--from");
    const to = parsePoint(toStr, "--to");

    await interaction.swipe(
      setup.udid,
      from.x,
      from.y,
      to.x,
      to.y,
      params.duration,
      setup.simBridgeOptions
    );

    return {
      success: true,
      message: `Swiped (${from.x},${from.y}) → (${to.x},${to.y})${
        params.duration !== undefined ? ` in ${params.duration}s` : ""
      }`,
      data: ctx.flags.json ? { from, to, duration: params.duration ?? null } : undefined,
      nextSteps: [
        { command: "snapshot -i", label: "Observe the result" },
        { command: "screenshot", label: "Take screenshot" },
      ],
    };
  },
};
