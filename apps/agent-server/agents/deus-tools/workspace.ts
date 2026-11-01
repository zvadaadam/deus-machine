// agent-server/agents/deus-tools/workspace.ts
// Workspace-aware tools: diff, comments, terminal output.

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { HostRpc } from "../../host-link";
import { tool } from "./sdk-tool";

/**
 * Creates the workspace tool definitions for a given session.
 * These tools handle user interaction and workspace state inspection.
 */
export function createWorkspaceTools(sessionId: string): SdkMcpToolDefinition<any>[] {
  return [
    // ====================================================================
    // GetWorkspaceDiff
    // ====================================================================
    tool(
      "GetWorkspaceDiff",
      `You can use this tool to see what the user is currently working on, or when the user refers to the "workspace diff", "PR diff", or "all changes". This compares all changes on the current branch (including uncommitted changes) against the merge base.
It's the same diff the user will see in the Deus UI, and the same diff that will be used in any PRs.
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
        console.log(`[deusMCPServer] getDiff invoked for session ${sessionId}`);

        const response = await HostRpc.requestGetDiff({
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
        console.log(`[deusMCPServer] DiffComment invoked for session ${sessionId}`);

        const { success } = await HostRpc.requestDiffComment({
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
        console.log(`[deusMCPServer] GetTerminalOutput invoked for session ${sessionId}`);

        const response = await HostRpc.requestGetTerminalOutput({
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
