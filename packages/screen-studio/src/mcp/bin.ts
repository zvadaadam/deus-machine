#!/usr/bin/env node
/**
 * screen-studio MCP server over stdio. The process owns the recordings it
 * starts and finalizes them on shutdown.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ffmpegVersion } from "../util/ffmpeg.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const version = await ffmpegVersion();
  console.error(
    version
      ? `[screen-studio-mcp] ffmpeg ${version}`
      : "[screen-studio-mcp] ffmpeg not found: recording and rendering will fail until it is installed"
  );
  const { server, shutdown } = createMcpServer();
  const stop = async () => {
    await shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("[screen-studio-mcp] fatal:", err);
  process.exit(1);
});
