import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import * as interaction from "../../engine/interaction.js";
import { readStdin } from "../read-stdin.js";
import { resolveCommandSetup } from "../runtime.js";

const schema = z.object({
  submit: z.boolean().optional(),
  _positionals: z.array(z.string()).optional(),
});

type Params = z.infer<typeof schema>;

export const typeCommand: CommandDefinition<Params> = {
  name: "type",
  description: "Type text into the focused field",
  usage: "type <text> [--submit]",
  examples: [
    'type "hello@example.com"',
    'type "password123" --submit',
    'echo "piped text" | device-use type',
  ],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    let text = params._positionals?.join(" ");

    if (!text && !process.stdin.isTTY) {
      text = await readStdin(ctx.flags.timeoutMs);
    }

    if (!text) {
      return {
        success: false,
        message:
          'No text provided.\nUsage: device-use type "hello"\nExample: device-use type "hello@example.com" --submit',
      };
    }

    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;

    await interaction.typeText(setup.udid, text, params.submit, setup.simBridgeOptions);

    const truncated = text.length > 40 ? `${text.slice(0, 40)}...` : text;
    return {
      success: true,
      message: `Typed "${truncated}"${params.submit ? " + Enter" : ""}`,
      data: {
        text,
        length: text.length,
        submitted: params.submit ?? false,
      },
      nextSteps: [{ command: "snapshot -i", label: "Observe the result" }],
    };
  },
};
