import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import * as interaction from "../../engine/interaction.js";
import { ValidationError } from "../../engine/errors.js";
import { resolveCommandSetup } from "../runtime.js";

const schema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  x: z.coerce.number().optional(),
  y: z.coerce.number().optional(),
  _positionals: z.array(z.string()).optional(),
});

type Params = z.infer<typeof schema>;

export const tapCommand: CommandDefinition<Params> = {
  name: "tap",
  aliases: ["click"],
  description: "Tap an element by ref, accessibility ID, label, or coordinates",
  usage: "tap <@ref | --id <id> | --label <text> | -x X -y Y>",
  examples: ["tap @e1", 'tap --id "loginButton"', 'tap --label "Sign In"', "tap -x 100 -y 200"],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;
    const { udid: resolved, simBridgeOptions, store } = setup;

    const refArg = params._positionals?.[0];

    if (refArg?.startsWith("@e")) {
      const entry = store.resolveRef(refArg);
      if (!entry) {
        return {
          success: false,
          message: `Ref ${refArg} not found. Run "device-use snapshot" first.`,
        };
      }

      await interaction.tapEntry(resolved, entry, simBridgeOptions);

      const desc = `${refArg} ${entry.type}${entry.label ? ` "${entry.label}"` : ""}`;
      return {
        success: true,
        message: `Tapped ${desc} @(${Math.round(entry.center.x)},${Math.round(entry.center.y)})`,
        data: {
          ref: refArg,
          type: entry.type,
          label: entry.label ?? null,
          identifier: entry.identifier ?? null,
          coordinates: { x: Math.round(entry.center.x), y: Math.round(entry.center.y) },
          method: entry.identifier ? "id" : entry.label ? "label" : "coordinates",
        },
        nextSteps: [
          { command: "snapshot -i", label: "Observe the result" },
          { command: "screenshot", label: "Take screenshot" },
        ],
      };
    }

    if (params.id) {
      await interaction.tapById(resolved, params.id, simBridgeOptions);
      return {
        success: true,
        message: `Tapped id="${params.id}"`,
        data: { id: params.id, method: "id" },
        nextSteps: [{ command: "snapshot -i", label: "Observe the result" }],
      };
    }

    if (params.label) {
      await interaction.tapByLabel(resolved, params.label, simBridgeOptions);
      return {
        success: true,
        message: `Tapped "${params.label}"`,
        data: { label: params.label, method: "label" },
        nextSteps: [{ command: "snapshot -i", label: "Observe the result" }],
      };
    }

    if (params.x !== undefined && params.y !== undefined) {
      await interaction.tap(resolved, params.x, params.y, simBridgeOptions);
      return {
        success: true,
        message: `Tapped (${params.x}, ${params.y})`,
        data: { coordinates: { x: params.x, y: params.y }, method: "coordinates" },
        nextSteps: [{ command: "snapshot -i", label: "Observe the result" }],
      };
    }

    throw new ValidationError("Provide a @ref, --id, --label, or --x/--y coordinates");
  },
};
