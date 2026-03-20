// sidecar/agents/opendevs-tools/workspace.ts
// Workspace-aware tools: user interaction, diff, comments, terminal output.

import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { EventBroadcaster } from "../../event-broadcaster";

/**
 * Creates the workspace tool definitions for a given session.
 * These tools handle user interaction and workspace state inspection.
 */
export function createWorkspaceTools(sessionId: string): SdkMcpToolDefinition<any>[] {
  return [
    // ====================================================================
    // AskUserQuestion
    // ====================================================================
    tool(
      "AskUserQuestion",
      "Use this tool when you need to ask the user questions during execution. This allows you to: 1. Gather user preferences or requirements, 2. Clarify ambiguous instructions, 3. Get decisions on implementation choices, 4. Offer choices to the user about what direction to take. IMPORTANT: An 'Other' option that allows free-form input is automatically provided to the user, so do NOT include 'Other' or similar options in your options array.",
      {
        questions: z
          .array(
            z.object({
              question: z.string().describe("The question to ask the user"),
              options: z
                .array(z.string())
                .max(4)
                .describe(
                  "Available options for the user to choose from (max 4). Do not include 'Other' - it is automatically provided."
                ),
              multiSelect: z
                .boolean()
                .optional()
                .describe(
                  "If true, user can select multiple options. Answers are comma-separated."
                ),
            })
          )
          .max(4),
      },
      async (args) => {
        console.log(`[opendevsMCPServer] AskUserQuestion invoked for session ${sessionId}`);

        let answers: (string | string[])[];
        try {
          const response = await EventBroadcaster.requestAskUserQuestion({
            sessionId,
            questions: args.questions,
          });
          answers = response.answers;
        } catch (err) {
          console.error("[opendevsMCPServer] AskUserQuestion request failed:", err);
          return {
            content: [
              {
                type: "text",
                text: "Question request failed (frontend may be unavailable or timed out). Please continue without this information or try again later.",
              },
            ],
          };
        }

        // Handle user cancellation
        if (answers.length === 1 && answers[0] === "USER_CANCELLED") {
          return {
            content: [
              {
                type: "text",
                text: "User cancelled the question. Please continue without this information or ask in a different way.",
              },
            ],
          };
        }

        const formatAnswer = (answer: string | string[], index: number): string => {
          if (Array.isArray(answer)) {
            const selections = answer.map((s) => `   - ${s}`).join("\n");
            return `${index + 1}.\n${selections}`;
          }
          return `${index + 1}. ${answer}`;
        };

        return {
          content: [
            {
              type: "text",
              text: `User responses:\n${answers
                .map((answer: string | string[], i: number) => formatAnswer(answer, i))
                .join("\n")}`,
            },
          ],
        };
      }
    ),

    // ====================================================================
    // GetWorkspaceDiff
    // ====================================================================
    tool(
      "GetWorkspaceDiff",
      `You can use this tool to see what the user is currently working on, or when the user refers to the "workspace diff", "PR diff", or "all changes". This compares all changes on the current branch (including uncommitted changes) against the merge base.
It's the same diff the user will see in the OpenDevs UI, and the same diff that will be used in any PRs.
With stat: true, returns git diff --stat style output showing per-file statistics. With file: 'path/to/file', returns the full unified diff for that specific file. With no parameters, returns the full unified diff for all changes.`,
      {
        file: z
          .string()
          .optional()
          .describe("Absolute path to the file to show the unified diff for"),
        stat: z
          .boolean()
          .optional()
          .describe("If true, return git diff --stat style output with per-file statistics"),
      },
      async (args) => {
        console.log(`[opendevsMCPServer] getDiff invoked for session ${sessionId}`);

        const response = await EventBroadcaster.requestGetDiff({
          sessionId,
          file: args.file,
          stat: args.stat,
        });

        if (response.error) {
          return {
            content: [{ type: "text", text: `Error getting diff: ${response.error}` }],
          };
        }

        return {
          content: [{ type: "text", text: response.diff || "No changes found." }],
        };
      }
    ),

    // ====================================================================
    // DiffComment
    // ====================================================================
    tool(
      "DiffComment",
      "Use this tool to leave comments on the user's diff during code review. Each comment targets a specific file and line number. Prefer plain text over markdown formatting.",
      {
        comments: z.array(
          z.object({
            file: z.string().describe("The file path to comment on"),
            lineNumber: z.number().describe("The line number to comment on"),
            body: z.string().describe("The comment body/content"),
          })
        ),
      },
      async (args) => {
        console.log(`[opendevsMCPServer] DiffComment invoked for session ${sessionId}`);

        const { success } = await EventBroadcaster.requestDiffComment({
          sessionId,
          comments: args.comments,
        });

        return {
          content: [
            {
              type: "text",
              text: success
                ? `Posted ${args.comments.length} comment(s) on the diff.`
                : `Failed to post comments.`,
            },
          ],
        };
      }
    ),

    // ====================================================================
    // GetTerminalOutput
    // ====================================================================
    tool(
      "GetTerminalOutput",
      `Use this tool to view terminal output in the user's workspace. This is helpful when:
- You need to see the output of a running command (like a dev server)
- You want to check for errors or logs from a build/test process
- The user mentions output they're seeing in their terminal
- You need to debug issues with a running process

Returns the terminal output along with information about what type of terminal it came from.`,
      {
        source: z
          .enum(["spotlight", "run_script", "terminal", "auto"])
          .optional()
          .describe(
            "Which terminal to read from: 'spotlight' (spotlight testing process), 'run_script' (dev server/run script), 'terminal' (user's interactive terminal), or 'auto' (automatically select the most relevant). Defaults to 'auto'."
          ),
        maxLines: z
          .number()
          .optional()
          .describe("Maximum number of lines to return. Defaults to 1000."),
      },
      async (args) => {
        console.log(`[opendevsMCPServer] GetTerminalOutput invoked for session ${sessionId}`);

        const response = await EventBroadcaster.requestGetTerminalOutput({
          sessionId,
          source: args.source,
          maxLines: args.maxLines,
        });

        if (response.error) {
          return {
            content: [{ type: "text", text: `Error getting terminal output: ${response.error}` }],
          };
        }

        if (response.source === "none") {
          return {
            content: [
              {
                type: "text",
                text: "No terminal output available. No active terminal, run script, or spotlight process found.",
              },
            ],
          };
        }

        const statusText = response.isRunning ? "running" : "stopped";
        const sourceLabel =
          response.source === "spotlight"
            ? "Spotlight"
            : response.source === "run_script"
              ? "Run script"
              : "Terminal";
        const header = `[${sourceLabel} - ${statusText}]\n`;

        return {
          content: [
            {
              type: "text",
              text: response.output
                ? header + response.output
                : `${header}No output available yet.`,
            },
          ],
        };
      }
    ),
  ];
}
