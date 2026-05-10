// agent-server/goals/tool.ts

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { EventBroadcaster } from "../event-broadcaster";
import { tool } from "../agents/deus-tools/sdk-tool";

const UpdateGoalArgsSchema = z.object({
  status: z.literal("complete"),
  summary: z.string().optional(),
});

const AskUserQuestionArgsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        options: z.array(z.string()).max(4),
        multiSelect: z.boolean().optional(),
        assumedAnswer: z.string().optional(),
      })
    )
    .max(4),
});

export const UPDATE_GOAL_TOOL_NAME = "update_goal";
export const ASK_USER_QUESTION_TOOL_NAME = "askUserQuestion";

export function createUpdateGoalMcpTool(sessionId: string): SdkMcpToolDefinition<any> {
  return tool(
    UPDATE_GOAL_TOOL_NAME,
    `Update the existing goal.
Use this tool only to mark the goal achieved.
Set status to "complete" only when the objective has actually been achieved and no required work remains.
Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.
You cannot use this tool to pause, resume, or budget-limit a goal; those status changes are controlled by the user or system.`,
    {
      status: z.literal("complete").describe("Required. The only allowed value is complete."),
      summary: z.string().optional().describe("Optional concise completion summary."),
    },
    async (args: unknown) => {
      const parsed = UpdateGoalArgsSchema.parse(args);
      const result = await EventBroadcaster.requestUpdateGoal({
        sessionId,
        status: parsed.status,
        summary: parsed.summary,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
}

export function createUpdateGoalDynamicToolSpec() {
  return {
    name: UPDATE_GOAL_TOOL_NAME,
    description:
      "Mark the active Deus goal complete. Call only when the objective is achieved and no required work remains.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: {
          type: "string",
          enum: ["complete"],
          description: "The only allowed value is complete.",
        },
        summary: {
          type: "string",
          description: "Optional concise completion summary.",
        },
      },
    },
  };
}

export function createAskUserQuestionDynamicToolSpec() {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description:
      "Ask the user one or more structured questions. Use only when progress depends on user input.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["question", "options"],
            properties: {
              question: { type: "string" },
              options: {
                type: "array",
                maxItems: 4,
                items: { type: "string" },
              },
              multiSelect: { type: "boolean" },
              assumedAnswer: {
                type: "string",
                description:
                  "Optional hint for the UI to preselect a matching option or show as the agent's suggested answer.",
              },
            },
          },
        },
      },
    },
  };
}

export async function handleUpdateGoalDynamicToolCall(
  sessionId: string,
  args: unknown
): Promise<{ contentItems: Array<{ type: "inputText"; text: string }>; success: boolean }> {
  const parsed = UpdateGoalArgsSchema.parse(args);
  const result = await EventBroadcaster.requestUpdateGoal({
    sessionId,
    status: parsed.status,
    summary: parsed.summary,
  });
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify(result, null, 2) }],
    success: true,
  };
}

export async function handleAskUserQuestionDynamicToolCall(
  sessionId: string,
  args: unknown
): Promise<{ contentItems: Array<{ type: "inputText"; text: string }>; success: boolean }> {
  const parsed = AskUserQuestionArgsSchema.parse(args);
  const response = await EventBroadcaster.requestAskUserQuestion({
    sessionId,
    questions: parsed.questions,
  });

  if (response.answers.length === 1 && response.answers[0] === "USER_CANCELLED") {
    return {
      contentItems: [
        {
          type: "inputText",
          text: "User cancelled the question. Continue without this information or ask in a different way.",
        },
      ],
      success: true,
    };
  }

  const formatted = response.answers
    .map((answer, index) =>
      Array.isArray(answer)
        ? `${index + 1}.\n${answer.map((value) => `   - ${value}`).join("\n")}`
        : `${index + 1}. ${answer}`
    )
    .join("\n");

  return {
    contentItems: [{ type: "inputText", text: `User responses:\n${formatted}` }],
    success: true,
  };
}
