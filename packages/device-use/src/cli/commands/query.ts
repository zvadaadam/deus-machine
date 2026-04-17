import { z } from "zod";
import type { AccessibilityNode, CommandDefinition, CommandResult } from "../../engine/types.js";
import { fetchAccessibilityTree } from "../../engine/accessibility.js";
import { filterTree } from "../../engine/snapshot/filter.js";
import { ValidationError } from "../../engine/errors.js";
import { resolveCommandSetup } from "../runtime.js";

const schema = z.object({
  // Filters — combined with AND.
  role: z.string().optional(),
  label: z.string().optional(),
  id: z.string().optional(),
  type: z.string().optional(),
  value: z.string().optional(),

  // Matchers.
  contains: z.boolean().optional(),
  exact: z.boolean().optional(),

  // Output selector.
  get: z.enum(["refs", "attrs", "text", "bool", "count"]).optional(),

  // Existence wait (seconds).
  wait: z.coerce.number().optional(),
  interval: z.coerce.number().optional(),
});

type Params = z.infer<typeof schema>;

interface QueryMatch {
  type: string;
  label?: string;
  identifier?: string;
  value?: string;
  role: string;
  frame: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  enabled: boolean;
}

function toMatch(node: AccessibilityNode): QueryMatch {
  const out: QueryMatch = {
    type: node.type,
    role: node.role,
    frame: node.frame,
    center: node.center,
    enabled: node.enabled,
  };
  if (node.label !== undefined) out.label = node.label;
  if (node.identifier !== undefined) out.identifier = node.identifier;
  if (node.value !== undefined) out.value = node.value;
  return out;
}

function compileMatcher(params: Params): (n: AccessibilityNode) => boolean {
  const exact = params.exact ?? false;
  const checks: Array<(n: AccessibilityNode) => boolean> = [];

  const eq = (actual: string | undefined, expected: string): boolean => {
    if (actual === undefined) return false;
    if (exact) return actual === expected;
    // default: substring (case-sensitive)
    return actual.includes(expected);
  };

  if (params.type) checks.push((n) => eq(n.type, params.type!));
  if (params.role) checks.push((n) => eq(n.role, params.role!));
  if (params.label) checks.push((n) => eq(n.label, params.label!));
  if (params.id) checks.push((n) => eq(n.identifier, params.id!));
  if (params.value) checks.push((n) => eq(n.value, params.value!));

  if (checks.length === 0) {
    throw new ValidationError("Provide at least one of --type --role --label --id --value");
  }

  // substring mode with --contains is the default; --exact flips to strict equality.
  // (--contains is accepted for readability but is already the default behaviour.)
  void params.contains;

  return (n: AccessibilityNode) => checks.every((c) => c(n));
}

export const queryCommand: CommandDefinition<Params> = {
  name: "query",
  aliases: ["find", "is", "exists"],
  description:
    "Query the accessibility tree by label/id/type/role. Returns refs, attrs, text, or a boolean.",
  usage:
    "query [--label X|--id X|--type X|--role X|--value X] [--exact] [--get refs|attrs|text|bool|count] [--wait <sec>]",
  examples: [
    'query --label "Sign In"',
    "query --id loginButton --get bool",
    "query --type TextField --get attrs",
    "query --label Welcome --wait 10 --get bool",
    "query --type Button --get count",
  ],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;
    const { udid, simBridgeOptions } = setup;

    const predicate = compileMatcher(params);
    const output = params.get ?? "attrs";
    const waitSec = params.wait;
    const intervalMs = (params.interval ?? 0.5) * 1000;
    const timeoutMs = waitSec !== undefined ? waitSec * 1000 : 0;

    const start = performance.now();
    let attempts = 0;
    let matches: AccessibilityNode[] = [];

    for (;;) {
      attempts++;
      const tree = await fetchAccessibilityTree(udid, simBridgeOptions);
      matches = filterTree(tree, predicate);

      const done = matches.length > 0 || timeoutMs === 0;
      if (done) break;

      const elapsed = performance.now() - start;
      if (elapsed + intervalMs > timeoutMs) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    const elapsedMs = Math.round(performance.now() - start);
    const foundAny = matches.length > 0;

    // --- Shape the response according to --get ---
    switch (output) {
      case "bool":
        return {
          success: foundAny,
          message: foundAny ? `Found ${matches.length} match(es)` : "No matches",
          data: ctx.flags.json ? { found: foundAny, count: matches.length } : String(foundAny),
        };

      case "count":
        return {
          success: true,
          message: `${matches.length} match${matches.length === 1 ? "" : "es"}`,
          data: ctx.flags.json ? { count: matches.length } : String(matches.length),
        };

      case "text": {
        const text = matches
          .map((m) => m.value ?? m.label ?? "")
          .filter(Boolean)
          .join("\n");
        return {
          success: foundAny,
          message: foundAny ? `Extracted text from ${matches.length} node(s)` : "No matches",
          data: ctx.flags.json ? { text, count: matches.length } : text,
        };
      }

      case "refs": {
        const shaped = matches.map(toMatch);
        return {
          success: foundAny,
          message: foundAny ? `${matches.length} match(es)` : "No matches",
          data: ctx.flags.json
            ? { matches: shaped, count: matches.length }
            : shaped.map((m) => formatOneLine(m)).join("\n") || "(none)",
        };
      }

      case "attrs":
      default: {
        const shaped = matches.map(toMatch);
        return {
          success: foundAny,
          message: foundAny
            ? `${matches.length} match(es)${waitSec !== undefined ? ` after ${elapsedMs}ms` : ""}`
            : `No matches${waitSec !== undefined ? ` after ${elapsedMs}ms (${attempts} polls)` : ""}`,
          data: ctx.flags.json
            ? { matches: shaped, count: matches.length, elapsedMs, attempts }
            : shaped.map((m) => formatOneLine(m)).join("\n") || "(none)",
        };
      }
    }
  },
};

function formatOneLine(m: QueryMatch): string {
  const parts = [m.type];
  if (m.label) parts.push(`"${m.label}"`);
  if (m.identifier) parts.push(`#${m.identifier}`);
  if (m.value) parts.push(`[${m.value}]`);
  parts.push(`@(${Math.round(m.center.x)},${Math.round(m.center.y)})`);
  if (!m.enabled) parts.push("(disabled)");
  return parts.join(" ");
}
