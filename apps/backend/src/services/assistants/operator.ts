// backend/src/services/assistants/operator.ts
// The operator tools this computer offers (`@zvada/agent-server/operator`,
// LLP 0019): the package's session tools over this computer's chats
// (./host.ts), and the three Deus adds (a workspace's changes, adding a
// project by cloning it (./add-project.ts), feedback to the Deus team).
//
// Two kinds of caller reach them. Outside callers (an assistant, a paired
// device, this computer's window) through MCP (`answerMcp`, the `agentMcp`
// operation): the list is the same for everyone, and the host's `authorize`
// reads an assistant's access per call. Every chat on this computer, as its
// own tools (`withSessionTools`): the engine delivers them with the Deus
// tools in one source, and the session's agent is the caller.
//
// Text from a repository (file names, diffs) and names are untrusted: a name
// is one quoted line (`quoted`), a diff a block of quoted lines (`quote`), so
// neither can read as one of the tool's own lines.

import { z } from "zod";
import * as Sentry from "@sentry/node";
import path from "node:path";
import {
  OperatorError,
  callHint,
  createMcpHandler,
  createOperator,
  operatorSessionTools,
  quote,
  quoted,
  tool,
  type ExternalCaller,
  type McpHandler,
  type Operator,
} from "@zvada/agent-server/operator";
import type { HostToolSource } from "@zvada/agent-server/core";
import * as workspaces from "@shared/api/workspaces";
import { DEUS_TOOLS_SERVER } from "@shared/mcp-servers";
import type { Caller } from "../../api/registry";
import { provideSessionTools } from "../agent/service";
import { getServerName } from "../server-name";
import { currentHost } from "./access";
import { addProjectTool } from "./add-project";
import { FEEDBACK_CATEGORIES, FeedbackNotSent, sendFeedback } from "./feedback";
import { createDeusHost, refusing, whereSentence, type DeusHost } from "./host";
import * as store from "./store";

/** One file's diff is cut here: enough to review a change, not a whole regenerated file. */
const DIFF_LIMIT = 20_000;
/** Files listed by `read_changes` before it says how many more there are. */
const FILES_LIMIT = 100;
/** The version of the tools this server offers, not of the app. */
const SERVER_VERSION = "2.0.0";

/** A path as git lists it, so `./a.ts`, `a.ts` and `b/../a.ts` are one file. */
const normal = (file: string) =>
  path.posix.normalize(file.replace(/\\/g, "/")).replace(/^\.\//, "");

const sessionArg = z
  .string()
  .trim()
  .min(1, "must not be empty or only spaces")
  .describe("The session, as list_sessions prints it");

function deusTools(host: DeusHost, operator: () => Operator<Caller>) {
  const readChanges = tool<
    { session: typeof sessionArg; file: z.ZodOptional<z.ZodString> },
    Caller
  >({
    name: "read_changes",
    title: "Read changes",
    description:
      "See what a session's coding agent changed in its workspace: the files with lines added and removed, or one file's diff.",
    input: {
      session: sessionArg,
      file: z
        .string()
        .min(1)
        .optional()
        .describe("A file as read_changes lists it, to see its diff"),
    },
    effect: "read",
    run: ({ session, file }, caller) =>
      refusing(async () => {
        const entry = await operator().find(caller, session);
        const workspaceId = entry.workspace.id;
        const name = quoted(entry.workspace.name);
        const { files, total_count } = await host.act(caller, workspaces.diffFiles, {
          workspaceId,
        });
        if (file) {
          const literal = path.posix.normalize(file);
          const listed =
            files.find((f) => f.file === literal) ??
            files.find((f) => normal(f.file) === normal(file));
          if (!listed) {
            throw new OperatorError(
              "not_found",
              `${quoted(file)} is not one of ${name}'s changed files. Nothing was shown.`,
              { next: callHint("read_changes", { session }) }
            );
          }
          const { diff } = await host.act(caller, workspaces.diffFile, {
            workspaceId,
            file: listed.file,
          });
          if (!diff.trim()) {
            if (listed.previous_path && !listed.additions && !listed.deletions) {
              return `${quoted(listed.file)} was renamed from ${quoted(listed.previous_path)}. Its content is unchanged.`;
            }
            return `${quoted(listed.file)} has no content patch.`;
          }
          const cut = diff.length > DIFF_LIMIT;
          return [
            `diff of ${quoted(listed.file)} (+${listed.additions} -${listed.deletions}):`,
            quote(cut ? diff.slice(0, DIFF_LIMIT) : diff),
            ...(cut ? [`(cut at ${DIFF_LIMIT} of ${diff.length} characters)`] : []),
          ].join("\n");
        }
        if (files.length === 0) return `${name}: no changes`;
        const total = total_count ?? files.length;
        const shown = files.slice(0, FILES_LIMIT);
        return [
          `${name}: ${total} file(s) changed`,
          ...shown.map((f) => {
            const from = f.previous_path ? ` (renamed from ${quoted(f.previous_path)})` : "";
            return `  ${quoted(f.file)}${from}  +${f.additions} -${f.deletions}`;
          }),
          ...(total > shown.length ? [`  (and ${total - shown.length} more)`] : []),
          `  ${callHint("read_changes", { session, file: shown[0]!.file })}`,
        ].join("\n");
      }),
  });

  const sendFeedbackTool = tool<
    {
      category: z.ZodOptional<z.ZodEnum<{ [K in (typeof FEEDBACK_CATEGORIES)[number]]: K }>>;
      subject: z.ZodOptional<z.ZodString>;
      message: z.ZodString;
    },
    Caller
  >({
    name: "send_feedback",
    title: "Send feedback",
    description:
      "Tell the Deus team about Deus itself: one of these tools broken, confusing or missing something, an answer that misled you, or something that worked notably well. Never about the person's task: leave out their code, files, names and data.",
    input: {
      category: z
        .enum(FEEDBACK_CATEGORIES)
        .optional()
        .describe(
          "tool: one of these tools (default); mcp: connecting or signing in; ux: what the person sees in Deus; docs; model: a coding agent's model; other"
        ),
      subject: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("The exact item, such as a tool's name"),
      message: z
        .string()
        .trim()
        .min(40)
        .max(5000)
        .describe("What happened and what you expected, specific enough to act on"),
    },
    // It posts outside, so it is a write; the host lets an assistant allowed to read send it.
    effect: "write",
    openWorld: true,
    async run({ category = "tool", subject, message }) {
      try {
        const receipt = await sendFeedback({
          category,
          message,
          ...(subject ? { subject } : {}),
          client: { name: "deus-assistant-tools", version: SERVER_VERSION },
        });
        // The board's words are another party's: quoted, as an agent's are.
        return [
          `Sent to the Deus team (thread ${quoted(receipt.threadId)}). Thank you.`,
          ...(receipt.knownIssue ? ["known issue:", quote(receipt.knownIssue)] : []),
          ...(receipt.guidance ? ["the Deus team:", quote(receipt.guidance)] : []),
        ].join("\n");
      } catch (error) {
        if (error instanceof FeedbackNotSent) {
          throw new OperatorError(
            "unsupported",
            `${error.message} Nothing was sent; try again later.`
          );
        }
        throw error;
      }
    },
  });

  return [readChanges, addProjectTool(host), sendFeedbackTool];
}

let operator: Operator<Caller> | null = null;

/** Made on first use: the host reads the app's operations, which are served by then. */
function theOperator(): Operator<Caller> {
  if (!operator) {
    const host = createDeusHost();
    const made: Operator<Caller> = createOperator<Caller>(host, {
      extra: deusTools(host, () => made),
      // What failed is reported here; the caller is told only the package's sentence.
      onError: (error, tool) => {
        Sentry.captureException(error, { tags: { operatorTool: tool } });
        console.error(`[Assistants] ${tool} failed:`, error);
      },
    });
    operator = made;
  }
  return operator;
}

/** An outside caller as the package knows it: an assistant speaks as itself, a device or the window as the person. */
function external(caller: Caller): ExternalCaller<Caller> {
  const assistant = caller.assistant;
  const host = assistant && currentHost();
  const name = host ? store.findAssistant(host, assistant.clientId)?.name : undefined;
  return {
    kind: "external",
    id: assistant
      ? `assistant:${assistant.clientId}`
      : caller.deviceId
        ? `device:${caller.deviceId}`
        : "window",
    speaksAs: assistant ? "assistant" : "person",
    ...(assistant ? { name: name ?? assistant.clientId } : {}),
    ...(caller.endsAt !== undefined ? { endsAt: caller.endsAt } : {}),
    auth: caller,
  };
}

let handler: McpHandler<Caller> | null = null;

/**
 * Answer one MCP message (or a batch) for `caller`: the JSON-RPC response, an
 * array for a batch, or null when there is nothing to answer. A refusal is an
 * `isError` tool result in words the model can act on; any other failure is
 * one generic sentence (the package's `refused (failed)`), reported by the host.
 */
export function answerMcp(message: unknown, caller: Caller): Promise<unknown> {
  handler ??= createMcpHandler(
    {
      tools: () => theOperator().tools(),
      call: (name, args, from: Caller) => theOperator().call(name, args, external(from)),
    },
    {
      name: "deus",
      version: SERVER_VERSION,
      title: `Deus on ${getServerName()}`,
      instructions: `${whereSentence()} Start with list_sessions to see them; what you may do here is decided by the person on this computer.`,
    }
  );
  return handler(message, caller);
}

/**
 * A chat's tools: the operator's (the chat itself the caller, as the engine
 * fills it) beside the Deus tools in one source. The Deus tools run as they
 * always have; the operator's words and rules are the package's. The
 * guidance goes in the turn's instructions, so it is not repeated here.
 */
export function withSessionTools(own: HostToolSource): HostToolSource {
  const ops = operatorSessionTools(theOperator(), { name: own.name, instructions: "" });
  const mine = new Set(own.tools.map((t) => t.name));
  return {
    ...own,
    name: DEUS_TOOLS_SERVER,
    tools: [...ops.tools, ...own.tools],
    call: (name, args, caller, signal) =>
      mine.has(name) ? own.call(name, args, caller, signal) : ops.call(name, args, caller, signal),
  };
}

// Every chat's tools carry the operator's from the engine's next session on.
provideSessionTools(withSessionTools);

/** Tests only: build the tools and the MCP handler again (over a new host). */
export function _resetOperator(): void {
  operator = null;
  handler = null;
}
