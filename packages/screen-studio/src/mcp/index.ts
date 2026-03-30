#!/usr/bin/env node

/**
 * Screen Studio MCP Server — CLI entry point.
 *
 * Starts the MCP server using stdio transport.
 * Designed to be run as a child process by an MCP host (e.g. Claude).
 *
 * Usage:
 *   node dist/mcp/index.js
 *   screen-studio-mcp
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { detectFfmpeg } from "./ffmpeg-recorder.js";

async function main(): Promise<void> {
  // Check ffmpeg availability (warn, don't fail — events-only mode works without it)
  const ffmpegVersion = await detectFfmpeg();
  if (!ffmpegVersion) {
    console.error("[screen-studio-mcp] Warning: ffmpeg not found on PATH. Screen capture and post-processing will be unavailable. Use captureMethod: 'none' for events-only mode.");
  } else {
    console.error(`[screen-studio-mcp] ffmpeg ${ffmpegVersion} detected`);
  }

  const { server, sessionManager } = createMcpServer();
  const transport = new StdioServerTransport();

  // Graceful shutdown: stop all recordings on SIGINT/SIGTERM
  const shutdown = async () => {
    console.error("[screen-studio-mcp] Shutting down, stopping all recordings...");
    await sessionManager.shutdownAll();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
  console.error("[screen-studio-mcp] Server running on stdio");
}

main().catch((err) => {
  console.error("[screen-studio-mcp] Fatal error:", err);
  process.exit(1);
});
