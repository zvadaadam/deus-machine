import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import { openUrl } from "../../engine/simctl.js";
import { fetchAccessibilityTree } from "../../engine/accessibility.js";
import * as interaction from "../../engine/interaction.js";
import { resolveCommandSetup } from "../runtime.js";

const schema = z.object({
  _positionals: z.array(z.string()).optional(),
  accept: z.boolean().optional(),
});

type Params = z.infer<typeof schema>;

/**
 * Detect the iOS 26 "Open in 'App'?" confirmation modal shown when simctl
 * openurl is used with a custom URL scheme (e.g. myapp://). Polls the a11y
 * tree for up to `timeoutMs` and taps the Open button when it appears.
 */
async function autoAcceptUrlSchemePrompt(
  udid: string,
  options: {
    timeoutMs: number;
    intervalMs: number;
    simBridgeOptions?: import("../../engine/simbridge.js").SimBridgeCallOptions;
  }
): Promise<"accepted" | "not-shown" | "timed-out"> {
  const start = performance.now();
  while (performance.now() - start < options.timeoutMs) {
    const tree = await fetchAccessibilityTree(udid, options.simBridgeOptions);

    let hasPrompt = false;
    // Walk: look for a StaticText with "Open in" + a sibling/nearby Button "Open".
    const stack: typeof tree = [...tree];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.type === "StaticText" && (n.label ?? "").startsWith("Open in")) {
        hasPrompt = true;
        break;
      }
      if (n.children) stack.push(...n.children);
    }

    if (hasPrompt) {
      try {
        await interaction.tapByLabel(udid, "Open", options.simBridgeOptions);
        return "accepted";
      } catch {
        // Fall through to retry — the button might not be tappable yet
      }
    }

    await new Promise((r) => setTimeout(r, options.intervalMs));
  }
  return "timed-out";
}

export const openUrlCommand: CommandDefinition<Params> = {
  name: "open-url",
  aliases: ["url"],
  description: "Open a URL or deep link in the simulator",
  usage: "open-url <url> [--accept]",
  examples: [
    "open-url https://example.com",
    "open-url myapp://deep-link/path",
    "open-url myapp://home --accept    # auto-tap the iOS URL-scheme confirm modal",
  ],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const url = params._positionals?.[0];
    if (!url) {
      return {
        success: false,
        message: "No URL provided. Usage: device-use open-url <url>",
      };
    }

    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;

    await openUrl(ctx.executor, setup.udid, url);

    let autoAccept: "accepted" | "not-shown" | "timed-out" | "disabled" = "disabled";
    if (params.accept) {
      // Give the modal ~200ms to render, then poll for up to 3s.
      await new Promise((r) => setTimeout(r, 200));
      autoAccept = await autoAcceptUrlSchemePrompt(setup.udid, {
        timeoutMs: 3000,
        intervalMs: 250,
        simBridgeOptions: setup.simBridgeOptions,
      });
      // If we never saw the prompt, treat as not-shown (e.g. universal link).
      if (autoAccept === "timed-out") autoAccept = "not-shown";
    }

    return {
      success: true,
      message:
        autoAccept === "accepted"
          ? `Opened ${url} (auto-accepted iOS URL-scheme prompt)`
          : `Opened ${url}`,
      data: ctx.flags.json ? { url, autoAccept } : undefined,
      nextSteps: [
        { command: "snapshot -i", label: "Take snapshot" },
        { command: "screenshot", label: "Take screenshot" },
      ],
    };
  },
};
