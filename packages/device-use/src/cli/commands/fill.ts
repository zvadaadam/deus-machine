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
  submit: z.boolean().optional(),
  _positionals: z.array(z.string()).optional(),
});

type Params = z.infer<typeof schema>;

/**
 * Atomic tap-then-type for form fields. Replaces the common two-step flow
 * `tap @e3 && type "value"` with a single command.
 *
 * Usage: fill <@ref|--id|--label|-x -y> <text> [--submit]
 * When a positional @ref is given, the second positional is the text.
 * When --id / --label / -x,-y identify the target, the first positional is the text.
 */
export const fillCommand: CommandDefinition<Params> = {
  name: "fill",
  description: "Tap a field and type into it in one step",
  usage: "fill <@ref|--id|--label|-x -y> <text> [--submit]",
  examples: [
    'fill @e3 "hello@example.com"',
    'fill --id "emailField" "me@example.com" --submit',
    'fill --label "Password" "secret"',
  ],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;
    const { udid: resolved, simBridgeOptions, store } = setup;

    const positionals = params._positionals ?? [];
    const hasCoords = params.x !== undefined && params.y !== undefined;

    // Decide which positional is the ref and which is the text.
    let refArg: string | undefined;
    let text: string | undefined;

    if (positionals[0]?.startsWith("@e")) {
      refArg = positionals[0];
      text = positionals.slice(1).join(" ") || undefined;
    } else if (params.id || params.label || hasCoords) {
      text = positionals.join(" ") || undefined;
    } else {
      throw new ValidationError("Provide a target: @ref, --id, --label, or --x/--y");
    }

    if (!text) {
      throw new ValidationError("Missing text to fill");
    }

    // --- Step 1: focus the field ---
    let methodLabel: string;
    if (refArg) {
      const entry = store.resolveRef(refArg);
      if (!entry) {
        return {
          success: false,
          message: `Ref ${refArg} not found. Run "device-use snapshot" first.`,
        };
      }
      await interaction.tapEntry(resolved, entry, simBridgeOptions);
      methodLabel = `${refArg}${entry.label ? ` "${entry.label}"` : ""}`;
    } else if (params.id) {
      await interaction.tapById(resolved, params.id, simBridgeOptions);
      methodLabel = `id="${params.id}"`;
    } else if (params.label) {
      await interaction.tapByLabel(resolved, params.label, simBridgeOptions);
      methodLabel = `label="${params.label}"`;
    } else {
      await interaction.tap(resolved, params.x!, params.y!, simBridgeOptions);
      methodLabel = `(${params.x},${params.y})`;
    }

    // --- Step 2: type the text ---
    await interaction.typeText(resolved, text, params.submit, simBridgeOptions);

    const truncated = text.length > 40 ? `${text.slice(0, 40)}…` : text;

    return {
      success: true,
      message: `Filled ${methodLabel} with "${truncated}"${params.submit ? " + Enter" : ""}`,
      data: {
        target: methodLabel,
        text,
        length: text.length,
        submitted: params.submit ?? false,
      },
      nextSteps: [{ command: "snapshot -i", label: "Observe the result" }],
    };
  },
};
