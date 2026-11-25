// agent-server/agents/deus-tools/workspace.ts
// Workspace-aware tools: diff, comments, terminal output.

import path from "node:path";
import { z } from "zod";
import { HostRpc } from "../../host-link";
import { trackedSessions } from "../../session-tracker";
import { type DeusTool, tool } from "./tool";

/**
 * Creates the workspace tool definitions for a given session.
 * These tools handle user interaction and workspace state inspection.
 */
export function createWorkspaceTools(sessionId: string): DeusTool[] {
  return [
    // ====================================================================
    // GetWorkspaceDiff
    // ====================================================================
    tool(
      "GetWorkspaceDiff",
      "Use this to see what the user is working on, or when they refer to the workspace diff, PR diff or all changes — by default it lists the changed paths since the merge base, including uncommitted changes. To get one file's unified diff, pass its path relative to the workspace, such as `src/index.ts`.",
      {
        file: z
          .string()
          .optional()
          .describe(
            "Path relative to the workspace for one file's unified diff, e.g. src/index.ts."
          ),
        stat: z.boolean().optional().describe("If true, return per-file additions and deletions."),
      },
      async (args) => {
        console.log(`[deusMCPServer] getDiff invoked for session ${sessionId}`);

        const cwd = trackedSessions.get(sessionId)?.cwd;
        let file = args.file;
        if (file && cwd && path.isAbsolute(file)) file = path.relative(cwd, file) || ".";
        const response = await HostRpc.requestGetDiff({ sessionId, file, stat: args.stat });

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
