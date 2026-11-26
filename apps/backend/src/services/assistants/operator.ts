// backend/src/services/assistants/operator.ts
// The operator tools this computer offers (`@zvada/agent-server/operator`,
// LLP 0019): the package's session tools over this computer's chats
// (./host.ts), and Deus's workspace changes, queue controls, project cloning and feedback.
//
// Two kinds of caller reach them. Outside callers (an assistant, a paired
// device, this computer's window) through MCP (`answerMcp`, the `agentMcp`
// operation): the list is the same for everyone, and the host's `authorize`
// reads an assistant's access per call. Every chat on this computer, as its
// own tools (`sessionTools`): the engine delivers them with the Deus
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
  json,
  operatorSessionTools,
  quote,
  quoted,
  refuse,
  tool,
  type ExternalCaller,
  type McpHandler,
  type Operator,
} from "@zvada/agent-server/operator";
import type { HostToolSource } from "@zvada/agent-server/core";
import { updateSessionTitle } from "@shared/api/sessions";
import * as workspaces from "@shared/api/workspaces";
import { DEUS_TOOLS_SERVER } from "@shared/mcp-servers";
import { TitleSchema } from "@shared/title";
import type { Caller } from "../../api/registry";
import { sameOrigin } from "../../db";
import { NotFoundError } from "../../lib/errors";
import { removeQueuedMessage, resumeQueuedMessages, steerQueuedMessage } from "../agent/queue";
import { holdingTurn } from "../agent/chat-turn";
import { getServerName } from "../server-name";
import { currentHost } from "./access";
import { addProjectTool } from "./add-project";
import { FEEDBACK_CATEGORIES, FeedbackNotSent, sendFeedback } from "./feedback";
import {
  createDeusHost,
  formatFileChange,
  mayTouch,
  queueView,
  refusing,
  whereSentence,
  type DeusHost,
  type Who,
} from "./host";
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

const words = z.string().trim().min(1, "must not be empty or only spaces");
const sessionArg = words.describe("The session, as list_sessions prints it");

function deusTools(host: DeusHost, operator: () => Operator<Caller>) {
  const renameInput = {
    session: words.optional().describe("A chat, as list_sessions prints it (workspace:N)"),
    workspace: words
      .optional()
      .describe("A workspace, by the name list_sessions prints after `workspace`"),
    name: TitleSchema.describe("The new name: one line, at most 120 characters"),
  };
  const rename = tool<typeof renameInput, Caller>({
    name: "rename",
    title: "Rename",
    description:
      "Rename a chat or a workspace. This is the name the person sees in Deus. Give exactly one of session or workspace. You may rename yourself and your own workspace, for example to show where your work stands. Rename another chat or workspace only if you started it or were asked to. A reference does not change: workspace:N stays the same after a rename.",
    input: renameInput,
    effect: "write",
    run: ({ session, workspace, name }, caller) =>
      refusing(async () => {
        const ref = session ?? workspace;
        if (!ref || (session && workspace))
          throw refuse.invalidInput(
            "rename",
            "session",
            "give exactly one of session or workspace"
          );
        const entry = await operator().find(caller, ref);
        const write = workspace
          ? host.act(caller, workspaces.updateWorkspaceTitle, {
              workspaceId: entry.workspace.id,
              title: name,
            })
          : host.act(caller, updateSessionTitle, { sessionId: entry.id, title: name });
        const { previousTitle } = await write.catch((error: unknown) => {
          if (session && entry.status === "setting_up" && error instanceof NotFoundError)
            throw new OperatorError(
              "busy",
              `${json(ref)} is being set up, so nothing was renamed.`,
              { next: callHint("wait_for_sessions", { sessions: [ref] }) }
            );
          throw error;
        });
        const target = workspace ? `workspace ${quoted(entry.workspace.name)}` : quoted(ref);
        return previousTitle
          ? `Renamed ${target}: ${quoted(previousTitle)} → ${quoted(name)}.`
          : `Named ${target}: ${quoted(name)}.`;
      }),
  });

  async function otherQueue(caller: Who, session: string) {
    const { id } = await operator().find(caller, session);
    if (caller.kind === "session" && id === caller.sessionId) throw refuse.self("session");
    return id;
  }
  const readQueueTool = tool<{ session: typeof sessionArg }, Caller>({
    name: "read_queue",
    title: "Read queue",
    description: "List another chat's queue in order, with ids, senders, states and any hold.",
    input: { session: sessionArg },
    effect: "read",
    run: async ({ session }, caller) => {
      const { items, senderName, hold } = queueView(caller, await otherQueue(caller, session));
      const rows = items.map(({ id, text, images, state, origin }, i) => {
        const first = [...text.match(/^[^\n\r\v\f\u0085\u2028\u2029]{0,161}/u)![0]];
        if (first.length > 160) first.splice(159, 2, "…");
        const preview =
          first.length || !images
            ? quoted(first.join(""))
            : `${images} image${images === 1 ? "" : "s"}`;
        return `${i + 1}. ${state} · from ${senderName(origin)} · ${preview} · message ${json(id)}`;
      });
      return [
        rows.length ? rows.join("\n") : "The queue is empty.",
        hold ?? "The queue is open.",
      ].join("\n");
    },
  });
  const manageInput = {
    session: sessionArg,
    action: z.enum(["send_now", "remove", "resume"]),
    message: z
      .string()
      .min(1)
      .optional()
      .describe("For send_now or remove, copy the message id from read_queue."),
  };
  const manageQueueTool = tool<typeof manageInput, Caller>({
    name: "manage_queue",
    title: "Manage queue",
    description: "Ask to send your waiting message now, remove it, or resume a held queue.",
    input: manageInput,
    effect: "write",
    run: ({ session, action, message }, caller) =>
      refusing(async () => {
        const sessionId = await otherQueue(caller, session);
        mayTouch(caller, sessionId);
        const { items, by, hold } = queueView(caller, sessionId);
        if (action === "resume") {
          const result = await resumeQueuedMessages(sessionId, by);
          const empty = items.length ? "" : " Nothing waits.";
          switch (result.outcome) {
            case "open":
              return "There is nothing to resume.";
            case "person_only":
            case "before_reset":
              throw new OperatorError(
                result.outcome === "person_only" ? "person_only" : "busy",
                `Nothing was resumed. The queue is ${hold}.${empty}`
              );
            case "resumed":
              return `Resumed. ${result.turnId ? `Started turn ${json(result.turnId)}.` : "No new turn started."} ${queueView(caller, sessionId).note ?? "Nothing waits"}.`;
          }
        }
        if (message === undefined)
          throw refuse.invalidInput(
            "manage_queue",
            "message",
            "copy the message id from read_queue"
          );
        const row = items.find((item) => item.id === message);
        if (!row) return "That message is no longer waiting.";
        if (by.kind !== "person" && !sameOrigin(row.origin, by))
          throw new OperatorError("not_yours", "Only its sender or the person can change it.");
        if (row.state !== "waiting") return "That message is no longer waiting.";
        if (action === "remove") {
          removeQueuedMessage(sessionId, message);
          return `Removed. ${queueView(caller, sessionId).note ?? "Nothing waits"}.`;
        }
        const turnId = holdingTurn(sessionId)?.turnId;
        const outcome = await steerQueuedMessage(sessionId, message, turnId, "in_place");
        if (outcome === "own_turn")
          return `It waits for its own turn in its place.${hold ? ` The queue is ${hold}.` : ""}`;
        if (outcome === "read" && turnId) return `Read in turn ${json(turnId)}.`;
        if (outcome === "unconfirmed")
          return "Delivery unconfirmed. It keeps its place in the queue.";
        if (outcome === "acknowledged" && turnId)
          return `Sent into turn ${json(turnId)}, not yet read. If the turn ends first, it keeps its place in the queue.`;
        if (outcome === "sent") return "Started as its own turn.";
        const now = queueView(caller, sessionId);
        const index = now.items.findIndex((item) => item.id === message);
        if (index < 0) return "That message is no longer waiting.";
        if (now.items[index]?.state === "sending") return "Starting as its own turn.";
        if (now.hold) return `The queue is ${now.hold}.`;
        if (outcome === "refused")
          return `The turn did not take it. Waiting at position ${index + 1}.`;
        if (outcome === "question" || outcome === "plan")
          return `Waiting behind the chat's ${outcome}.`;
        return `Waiting at position ${index + 1}.`;
      }),
  });
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
          ...shown.map((change) => `  ${formatFileChange(change)}`),
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
          `Sent to the Deus team (thread ${json(receipt.threadId)}). Thank you.`,
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

  return [
    readChanges,
    readQueueTool,
    manageQueueTool,
    rename,
    addProjectTool(host),
    sendFeedbackTool,
  ];
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

export function operatorTools(additional?: HostToolSource): HostToolSource {
  return operatorSessionTools(theOperator(), {
    name: DEUS_TOOLS_SERVER,
    with: additional,
  });
}

/** Tests only: build the tools and the MCP handler again (over a new host). */
export function _resetOperator(): void {
  operator = null;
  handler = null;
}
