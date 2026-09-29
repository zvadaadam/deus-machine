import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectToolRequest } from "@shared/agent-side-channel";
import { getErrorMessage } from "@shared/lib/errors";
import { z } from "zod";
import { HostRpc } from "../../host-link";
import { tool } from "./sdk-tool";

export interface ProjectToolSource {
  currentTurnId: () => string | undefined;
}

/** Every operation is scoped by the running session, never a model-supplied Project ID. */
export function createProjectTools(
  sessionId: string,
  source: ProjectToolSource
): SdkMcpToolDefinition<any>[] {
  function projectTool(
    operation: ProjectToolRequest["operation"],
    description: string,
    schema: Record<string, unknown>
  ): SdkMcpToolDefinition<any> {
    return tool(operation, description, schema, async (args: Record<string, unknown>) => {
      // Capture before the relay: the engine may finish this turn while a request
      // is in flight. Reading the source on the backend would relabel old work.
      const turnId = source.currentTurnId();
      if (!turnId) {
        return {
          isError: true,
          content: [{ type: "text", text: "Project tools require an active Project agent turn." }],
        };
      }
      const request: ProjectToolRequest = {
        sessionId,
        turnId,
        toolCallId: crypto.randomUUID(),
        operation,
        args,
      };
      try {
        const result = await HostRpc.requestProjectTool(request);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Project error: ${getErrorMessage(error)}` }],
        };
      }
    });
  }

  return [
    projectTool(
      "create_agent",
      "Delegate a bounded task to a new Project agent. Creates its dedicated workspace and conversation, then queues the task. Coordinator only. Child outcomes are delivered automatically; do not poll. Available only inside a Deus Project.",
      {
        title: z.string().min(1).max(160),
        task: z.string().min(1).max(32_000),
        repositoryId: z.string().optional(),
      }
    ),
    projectTool(
      "get_agent_status",
      "Read Project agent status, assignment and local execution references, including the backend's checkout path and configured branch. Omit agentId to list the agents you can access. Reading status does not acknowledge or consume completion notifications.",
      { agentId: z.string().optional() }
    ),
    projectTool(
      "read_agent_transcript",
      "Read recent messages and bounded tool input/result/error excerpts from an authorized Project agent's conversation. Use result summaries first. Pass nextBeforeMessageId back as beforeMessageId to continue into older messages; pages read chronologically and excerpts may be abbreviated. Reading does not consume completion notifications.",
      {
        agentId: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
        beforeMessageId: z.string().min(1).max(160).optional(),
      }
    ),
    projectTool(
      "send_to_agent",
      "Queue a message for a Project agent's current conversation. Use agentId='coordinator' and kind='question' when blocked, then finish your turn so the coordinator can respond. Use kind='reply' with replyTo to answer a question. Delivery is durable and never interrupts a running turn.",
      {
        agentId: z.string(),
        message: z.string().min(1).max(32_000),
        kind: z.enum(["message", "question", "reply"]).optional(),
        replyTo: z.string().optional(),
      }
    ),
    projectTool(
      "report_result",
      "Publish your assignment's result summary and optional result documents and PR links. Describe what changed, validation and remaining limitations. Provide relative file paths; Deus stores them under your assignment's results folder. Publishing is distinct from finishing your turn and human acceptance.",
      {
        summary: z.string().min(1).max(16_000),
        files: z
          .array(z.object({ path: z.string(), content: z.string() }))
          .max(20)
          .optional(),
        pullRequests: z.array(z.string().url()).max(20).optional(),
      }
    ),
    projectTool(
      "stop_agent",
      "Pause a Project agent's future work and request cancellation of its active turn. Coordinator only. An unconfirmed cancellation may still be executing; inspect the returned status before assuming work has stopped.",
      { agentId: z.string() }
    ),
    projectTool(
      "publish_context",
      "List, read or explicitly publish versioned Project documents. A workspace file is not shared until published. Coordinators may publish planning documents; contributors publish result documents through report_result. Supply expectedRevision when publishing to prevent overwriting a concurrent change.",
      {
        mode: z.enum(["list", "read", "publish"]),
        path: z.string().optional(),
        content: z.string().optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
      }
    ),
  ];
}
