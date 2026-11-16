// backend/src/services/assistants/operator.ts
// The operator tools this computer offers: the module's session tools over
// this computer's workspaces (./host.ts), and the three Deus adds (a
// workspace's changes, archiving it, feedback to the Deus team). What a caller
// may run is decided here.
//
// They are served over MCP (`answerMcp`, the `agentMcp` operation): the
// module's handler answers `initialize`, `tools/list` and `tools/call`.
// The list is the same for everyone: an assistant keeps it from when it
// connected, so it cannot follow an access level. Access is checked per call:
// this computer's window and its paired devices may run everything; an
// assistant the person allowed to read runs the tools that only read; one not
// allowed yet, or denied, runs nothing. Each write is checked again just before
// it happens (the host's `act`).
//
// Text from a repository (file names, diffs) and names are untrusted: a name
// is one quoted line (`quoted`), a diff a block of quoted lines (`quote`), so
// neither can read as one of the tool's own lines.

import { z } from "zod";
import path from "node:path";
import * as Sentry from "@sentry/node";
import {
  OperatorError,
  callHint,
  createMcpHandler,
  createOperator,
  quote,
  quoted,
  tool,
  type McpHandler,
  type Operator,
  type ToolSource,
} from "@zvada/agent-server/operator";
import * as workspaces from "@shared/api/workspaces";
import { LOCAL_CALLER, type Caller } from "../../api/registry";
import { AppError } from "../../lib/errors";
import { getServerName } from "../server-name";
import { refusalFor } from "./access";
import { ASSISTANT_FAILURE } from "./sentences";
import { FEEDBACK_CATEGORIES, FeedbackNotSent, sendFeedback } from "./feedback";
import { createDeusHost, maxWaitFor, type DeusHost } from "./host";

/** One file's diff is cut here: enough to review a change, not a whole regenerated file. */
const DIFF_LIMIT = 20_000;
/** Files listed by `read_changes` before it says how many more there are. */
const FILES_LIMIT = 100;
/** The version of the tools this server offers, not of the app. */
const SERVER_VERSION = "1.0.0";

/** A path as git lists it, so `./a.ts`, `a.ts` and `b/../a.ts` are one file. */
const normal = (file: string) =>
  path.posix.normalize(file.replace(/\\/g, "/")).replace(/^\.\//, "");

// Trimmed and refused when nothing is left, in the module's words for its own.
const sessionArg = z
  .string()
  .trim()
  .min(1, "must not be empty or only spaces")
  .describe("The session: its name as list_sessions shows it, group/name, or its id");

function deusTools(host: DeusHost, operator: () => Operator<Caller>) {
  const workspaceFor = async (caller: Caller, session: string) => {
    const entry = await operator().find(caller, session);
    return { entry, workspace: await host.workspaceOf(entry.id) };
  };

  const readChanges = tool({
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
    readOnly: true,
    async run({ session, file }, caller: Caller) {
      const { workspace } = await workspaceFor(caller, session);
      const { files, total_count } = await host.act(caller, workspaces.diffFiles, {
        workspaceId: workspace.id,
      });
      if (file) {
        // Only a changed file: the diff of an unchanged one is the whole file,
        // and that may be a secret git ignores (.env).
        const listed = files.find((f) => normal(f.file) === normal(file));
        if (!listed) {
          throw new OperatorError(
            `${quoted(file)} is not one of ${quoted(workspace.slug)}'s changed files. Nothing was shown.\n  ${callHint("read_changes", { session })}`
          );
        }
        const { diff } = await host.act(caller, workspaces.diffFile, {
          workspaceId: workspace.id,
          file: listed.file,
        });
        const name = quoted(listed.file);
        if (!diff.trim()) return `${name}: no changes`;
        const cut = diff.length > DIFF_LIMIT;
        return [
          `diff of ${name} (+${listed.additions} -${listed.deletions}):`,
          quote(cut ? diff.slice(0, DIFF_LIMIT) : diff),
          ...(cut ? [`(cut at ${DIFF_LIMIT} of ${diff.length} characters)`] : []),
        ].join("\n");
      }
      if (files.length === 0) return `${quoted(workspace.slug)}: no changes`;
      const total = total_count ?? files.length;
      const shown = files.slice(0, FILES_LIMIT);
      return [
        `${quoted(workspace.slug)}: ${total} file(s) changed`,
        ...shown.map((f) => `  ${quoted(f.file)}  +${f.additions} -${f.deletions}`),
        ...(total > shown.length ? [`  (and ${total - shown.length} more)`] : []),
        `  ${callHint("read_changes", { session, file: shown[0]!.file })}`,
      ].join("\n");
    },
  });

  const archiveWorkspace = tool({
    name: "archive_workspace",
    title: "Archive workspace",
    description:
      "Put a finished session's workspace away: it leaves the list, and its branch and changes are kept. One whose start failed is removed instead.",
    input: { session: sessionArg },
    readOnly: false,
    destructive: true,
    async run({ session }, caller: Caller) {
      const { entry, workspace } = await workspaceFor(caller, session);
      // Whatever its view says: setup's end would set it ready again.
      if (workspace.state === "initializing") {
        throw new OperatorError(
          `${quoted(entry.name)} is still being set up. Nothing was archived.\n  ${callHint("wait_for_session", { session })}`
        );
      }
      if (entry.phase === "working" || entry.phase === "needs_input") {
        throw new OperatorError(
          `${quoted(entry.name)} is still ${entry.phase === "working" ? "working" : "waiting on an answer"}. Nothing was archived.\n  ${callHint("stop_session", { session })}`
        );
      }
      // A start that failed has no chat, branch or changes to keep: it is removed, as the app does.
      if (workspace.state === "error" && !workspace.current_session_id) {
        await host.act(caller, workspaces.deleteWorkspace, { workspaceId: workspace.id });
        return `removed ${quoted(entry.name)}: its start had failed, so there was nothing to keep.`;
      }
      await host.act(caller, workspaces.archiveWorkspace, { workspaceId: workspace.id });
      // The branch by name: where the person finds the work again.
      const branch = workspace.git_branch ? ` ${quoted(workspace.git_branch)}` : "";
      return `archived ${quoted(entry.name)}. Its branch${branch} and changes are kept.`;
    },
  });

  const sendFeedbackTool = tool({
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
    // It changes nothing on this computer, so an assistant allowed to read may send it.
    readOnly: true,
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
          throw new OperatorError(`${error.message} Nothing was sent; try again later.`);
        }
        throw error;
      }
    },
  });

  return [readChanges, archiveWorkspace, sendFeedbackTool];
}

let operator: Operator<Caller> | null = null;

/** Made on first use: the host reads the app's operations, which are served by then. */
function theOperator(): Operator<Caller> {
  if (!operator) {
    const host = createDeusHost();
    const made: Operator<Caller> = createOperator<Caller>(host, {
      // A held call answers "still working" before the caller's connection is cut.
      maxWaitSeconds: (caller) => maxWaitFor(caller),
      extra: deusTools(host, () => made),
    });
    operator = made;
  }
  return operator;
}

/**
 * The tools as MCP lists and runs them. The list is the same for every
 * caller. A call is checked against the caller's access first; a refusal is
 * thrown with words the model can act on, and the MCP handler answers it as an
 * `isError` tool result. Anything else that fails is a bug: reported here, and
 * an assistant is told only `ASSISTANT_FAILURE`, never its internal text.
 */
const source: ToolSource<Caller> = {
  tools: () => theOperator().tools(LOCAL_CALLER),
  async call(name, args, caller) {
    const ops = theOperator();
    const { assistant } = caller;
    if (assistant) {
      const found = ops.tools(caller).find((t) => t.name === name);
      const refusal = refusalFor(assistant.access, found?.readOnly === false ? "operate" : "read");
      if (refusal) throw new OperatorError(refusal);
    }
    try {
      return await ops.call(name, args, caller);
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      // A refusal of the app's own (access read again, a conflict, a not-found):
      // the MCP binding passes only an OperatorError's words through as written.
      if (error instanceof AppError) throw new OperatorError(error.message);
      Sentry.captureException(error);
      console.error(`[Assistants] ${name} failed:`, error);
      throw assistant ? new Error(ASSISTANT_FAILURE) : error;
    }
  },
};

let handler: McpHandler<Caller> | null = null;

/**
 * Answer one MCP message (or a batch) for `caller`: the JSON-RPC response, an
 * array for a batch, or null when there is nothing to answer. Built on first
 * use, titled with this computer's name as it is then.
 */
export function answerMcp(message: unknown, caller: Caller): Promise<unknown> {
  handler ??= createMcpHandler(source, {
    name: "deus",
    version: SERVER_VERSION,
    title: `Deus on ${getServerName()}`,
    instructions:
      "Start with list_sessions to see the coding agents on this computer; what you may do here is decided by the person on this computer.",
  });
  return handler(message, caller);
}

/** Tests only: build the tools and the MCP handler again (over a new host). */
export function _resetOperator(): void {
  operator = null;
  handler = null;
}
