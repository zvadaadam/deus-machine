import { z } from "zod";
import type { CommandDefinition, CommandContext, CommandResult } from "../engine/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCommand = CommandDefinition<any>;

const commands = new Map<string, AnyCommand>();
const aliases = new Map<string, string>();

export function register(definition: AnyCommand): void {
  commands.set(definition.name, definition);
  if (definition.aliases) {
    for (const alias of definition.aliases) {
      aliases.set(alias, definition.name);
    }
  }
}

export function resolve(name: string): AnyCommand | undefined {
  return commands.get(name) ?? commands.get(aliases.get(name) ?? "");
}

export function listCommands(): AnyCommand[] {
  return Array.from(commands.values());
}

export function getCommandFlagKeys(definition?: CommandDefinition): Set<string> {
  if (!definition || !(definition.schema instanceof z.ZodObject)) {
    return new Set();
  }
  return new Set(Object.keys(definition.schema.shape));
}

function formatCommandHelp(def: CommandDefinition): string {
  return [
    `Usage: device-use ${def.usage}`,
    "",
    def.description,
    ...(def.aliases?.length ? ["", `Aliases: ${def.aliases.join(", ")}`] : []),
    ...(def.examples?.length
      ? ["", "Examples:", ...def.examples.map((ex) => `  device-use ${ex}`)]
      : []),
  ].join("\n");
}

export async function dispatch(
  name: string,
  rawFlags: Record<string, string | boolean>,
  positionals: string[],
  ctx: CommandContext
): Promise<CommandResult> {
  const def = resolve(name);
  if (!def) {
    return {
      success: false,
      message: `Unknown command: ${name}. Run "device-use --help" for usage.`,
    };
  }

  if (rawFlags["help"] || rawFlags["h"]) {
    return {
      success: true,
      message: formatCommandHelp(def),
    };
  }

  const input = { ...rawFlags, _positionals: positionals };
  const parsed = def.schema.safeParse(input);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join(", ");
    const message = [
      `Invalid arguments: ${issues}`,
      `Usage: device-use ${def.usage}`,
      def.examples?.length ? `Example: device-use ${def.examples[0]}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    return { success: false, message };
  }

  return def.handler(parsed.data, ctx);
}
