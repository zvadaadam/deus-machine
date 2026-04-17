import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import { fetchAccessibilityTree } from "../../engine/accessibility.js";
import { buildSnapshot } from "../../engine/snapshot/build.js";
import { formatCompact, formatTree } from "../../engine/snapshot/format.js";
import { diffSnapshots, formatDiff } from "../../engine/snapshot/diff.js";
import { resolveCommandSetup } from "../runtime.js";

const schema = z.object({
  i: z.boolean().optional(),
  interactive: z.boolean().optional(),
  flat: z.boolean().optional(),
  diff: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

type Params = z.infer<typeof schema>;

export const snapshotCommand: CommandDefinition<Params> = {
  name: "snapshot",
  description:
    "Fetch the accessibility tree with @refs on visible interactive nodes (--hidden to include off-screen)",
  usage: "snapshot [-i|--interactive] [--flat] [--diff] [--hidden]",
  examples: [
    "snapshot",
    "snapshot -i",
    "snapshot -i --flat",
    "snapshot -i --hidden       # include off-screen refs too",
    "snapshot -i --diff --json",
  ],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;
    const { udid, simBridgeOptions, store } = setup;

    const raw = await fetchAccessibilityTree(udid, simBridgeOptions);

    const interactiveOnly = params.i || params.interactive || false;
    const snap = buildSnapshot(raw, {
      interactiveOnly,
      includeHidden: params.hidden ?? false,
      startCounter: store.getRefCounter(),
    });

    // Persist flat refs so `tap @eN` continues to work across commands.
    store.setRefs(snap.refs, store.getRefCounter() + snap.refs.length);

    // Diff is computed against the previous flat-ref snapshot.
    const currentEntries = snap.refs.map(({ ref: _ref, ...rest }) => rest);
    const previousEntries = store.getPreviousSnapshot();
    const diffResult =
      params.diff && previousEntries ? diffSnapshots(previousEntries, currentEntries) : null;
    store.setPreviousSnapshot(currentEntries);

    // Text output: tree view by default, flat when --flat.
    const text = params.flat ? formatCompact(snap.refs) : formatTree(snap.tree);
    const diffText = diffResult ? `\n\n${formatDiff(diffResult)}` : "";

    const diffSummary = diffResult
      ? ` (${diffResult.added.length} added, ${diffResult.removed.length} removed, ${diffResult.changed.length} changed)`
      : "";

    const warnings: string[] = [];
    if (params.diff && !previousEntries) {
      warnings.push("No previous snapshot to diff against — run snapshot again to see changes");
    }

    const firstRef = snap.refs[0]?.ref;
    const firstType = snap.refs[0]?.type;

    return {
      success: true,
      message: `${snap.counts.interactive} interactive / ${snap.counts.total} total element${snap.counts.total === 1 ? "" : "s"}${diffSummary}`,
      data: ctx.flags.json
        ? {
            tree: snap.tree,
            refs: snap.refs,
            counts: snap.counts,
            ...(diffResult ? { diff: diffResult } : {}),
          }
        : text + diffText,
      nextSteps: firstRef
        ? [
            { command: `tap ${firstRef}`, label: `Tap ${firstType}` },
            { command: "screenshot", label: "Take screenshot" },
          ]
        : [],
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
