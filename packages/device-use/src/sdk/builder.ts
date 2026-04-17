import type { CommandExecutor, RefEntry, SnapshotNode } from "../engine/types.js";
import { fetchAccessibilityTree } from "../engine/accessibility.js";
import * as interaction from "../engine/interaction.js";
import {
  bootSimulator,
  launchApp,
  openUrl,
  resolveSimulator,
  takeScreenshot,
} from "../engine/simctl.js";
import { buildSnapshot } from "../engine/snapshot/build.js";
import { RefMap } from "../engine/snapshot/refs.js";
import { createExecutor } from "../engine/utils/exec.js";
import { resolveBundleId } from "./apps.js";
import {
  waitFor as engineWaitFor,
  type WaitForPredicate,
  type WaitForOptions,
} from "../engine/wait-for.js";

type Step =
  | { kind: "app"; name: string }
  | { kind: "snapshot" }
  | { kind: "tap"; ref: string }
  | { kind: "tapId"; identifier: string }
  | { kind: "tapLabel"; label: string }
  | { kind: "inputText"; text: string; submit?: boolean }
  | { kind: "screenshot"; path?: string }
  | { kind: "swipe"; startX: number; startY: number; endX: number; endY: number }
  | { kind: "wait"; ms: number }
  | { kind: "pressButton"; button: string }
  | { kind: "custom"; fn: (ctx: RunContext) => Promise<void> }
  | { kind: "waitFor"; predicate: WaitForPredicate; description: string; options?: WaitForOptions }
  | { kind: "openUrl"; url: string };

export interface RunContext {
  udid: string;
  refs: RefMap;
  entries: RefEntry[];
  tree: SnapshotNode[];
  log: StepLog[];
}

export interface StepLog {
  step: string;
  durationMs: number;
  detail?: string;
}

export class Session {
  private simulatorName: string;
  private steps: Step[] = [];

  constructor(simulatorName: string) {
    this.simulatorName = simulatorName;
  }

  app(nameOrBundleId: string): this {
    this.steps.push({ kind: "app", name: nameOrBundleId });
    return this;
  }

  snapshot(): this {
    this.steps.push({ kind: "snapshot" });
    return this;
  }

  tapOn(ref: string): this {
    this.steps.push({ kind: "tap", ref: normalizeRef(ref) });
    return this;
  }

  tapId(identifier: string): this {
    this.steps.push({ kind: "tapId", identifier });
    return this;
  }

  tapLabel(label: string): this {
    this.steps.push({ kind: "tapLabel", label });
    return this;
  }

  inputText(text: string, opts?: { submit?: boolean }): this {
    this.steps.push({ kind: "inputText", text, submit: opts?.submit });
    return this;
  }

  screenshot(path?: string): this {
    this.steps.push({ kind: "screenshot", path });
    return this;
  }

  swipe(startX: number, startY: number, endX: number, endY: number): this {
    this.steps.push({ kind: "swipe", startX, startY, endX, endY });
    return this;
  }

  wait(ms: number): this {
    this.steps.push({ kind: "wait", ms });
    return this;
  }

  pressButton(button: string): this {
    this.steps.push({ kind: "pressButton", button });
    return this;
  }

  waitFor(predicate: WaitForPredicate, opts?: WaitForOptions & { description?: string }): this {
    this.steps.push({
      kind: "waitFor",
      predicate,
      description: opts?.description ?? "custom predicate",
      options: opts,
    });
    return this;
  }

  waitForLabel(label: string, opts?: WaitForOptions): this {
    this.steps.push({
      kind: "waitFor",
      predicate: (n) => n.label === label,
      description: `label="${label}"`,
      options: opts,
    });
    return this;
  }

  waitForId(identifier: string, opts?: WaitForOptions): this {
    this.steps.push({
      kind: "waitFor",
      predicate: (n) => n.identifier === identifier,
      description: `id="${identifier}"`,
      options: opts,
    });
    return this;
  }

  waitForType(type: string, opts?: WaitForOptions): this {
    this.steps.push({
      kind: "waitFor",
      predicate: (n) => n.type === type,
      description: `type="${type}"`,
      options: opts,
    });
    return this;
  }

  openUrl(url: string): this {
    this.steps.push({ kind: "openUrl", url });
    return this;
  }

  do(fn: (ctx: RunContext) => Promise<void>): this {
    this.steps.push({ kind: "custom", fn });
    return this;
  }

  async run(): Promise<RunContext> {
    const executor = createExecutor();
    const sim = await resolveSimulator(executor, this.simulatorName);
    await bootSimulator(executor, sim.udid);

    const ctx: RunContext = {
      udid: sim.udid,
      refs: new RefMap(0),
      entries: [],
      tree: [],
      log: [],
    };

    for (const step of this.steps) {
      const start = performance.now();
      await executeStep(step, ctx, executor);
      const durationMs = Math.round(performance.now() - start);
      ctx.log.push({ step: describeStep(step), durationMs });
    }

    return ctx;
  }
}

async function executeStep(step: Step, ctx: RunContext, executor: CommandExecutor): Promise<void> {
  switch (step.kind) {
    case "app": {
      const bundleId = resolveBundleId(step.name);
      await launchApp(executor, ctx.udid, bundleId);
      await delay(500);
      break;
    }

    case "snapshot": {
      const nodes = await fetchAccessibilityTree(ctx.udid);
      const snap = buildSnapshot(nodes, { interactiveOnly: true, refMap: ctx.refs });
      ctx.entries = snap.refs;
      ctx.tree = snap.tree;
      break;
    }

    case "tap": {
      const entry = ctx.refs.resolve(step.ref);
      if (!entry) {
        throw new Error(
          `Ref ${step.ref} not found. Available refs: ${ctx.entries.map((e) => e.ref).join(", ") || "(none — call .snapshot() first)"}`
        );
      }
      await interaction.tapEntry(ctx.udid, entry);
      break;
    }

    case "tapId":
      await interaction.tapById(ctx.udid, step.identifier);
      break;

    case "tapLabel":
      await interaction.tapByLabel(ctx.udid, step.label);
      break;

    case "inputText":
      await interaction.typeText(ctx.udid, step.text, step.submit);
      break;

    case "screenshot": {
      const path = step.path ?? `/tmp/device-use-screenshot-${Date.now()}.png`;
      await takeScreenshot(executor, ctx.udid, path);
      break;
    }

    case "swipe":
      await interaction.swipe(ctx.udid, step.startX, step.startY, step.endX, step.endY);
      break;

    case "wait":
      await delay(step.ms);
      break;

    case "pressButton":
      await interaction.pressButton(ctx.udid, step.button);
      break;

    case "custom":
      await step.fn(ctx);
      break;

    case "waitFor": {
      const result = await engineWaitFor(ctx.udid, step.predicate, step.options);
      if (!result.found) throw new Error(`Timed out waiting for element: ${step.description}`);
      break;
    }

    case "openUrl":
      await openUrl(executor, ctx.udid, step.url);
      await delay(500);
      break;
  }
}

/** Normalize shorthand refs: "@2" → "@e2", "@e2" stays "@e2". */
function normalizeRef(ref: string): string {
  if (ref.startsWith("@e")) return ref;
  return `@e${ref.replace(/^@/, "")}`;
}

function describeStep(step: Step): string {
  switch (step.kind) {
    case "app":
      return `app(${step.name})`;
    case "snapshot":
      return "snapshot()";
    case "tap":
      return `tapOn(${step.ref})`;
    case "tapId":
      return `tapId(${step.identifier})`;
    case "tapLabel":
      return `tapLabel(${step.label})`;
    case "inputText":
      return `inputText("${step.text}")`;
    case "screenshot":
      return `screenshot(${step.path ?? "auto"})`;
    case "swipe":
      return `swipe(${step.startX},${step.startY} → ${step.endX},${step.endY})`;
    case "wait":
      return `wait(${step.ms}ms)`;
    case "pressButton":
      return `pressButton(${step.button})`;
    case "custom":
      return "do(custom)";
    case "waitFor":
      return `waitFor(${step.description})`;
    case "openUrl":
      return `openUrl(${step.url})`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
