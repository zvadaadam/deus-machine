import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "compositor/index": "src/compositor/index.ts",
    "cli/index": "src/cli/index.ts",
    "mcp/index": "src/mcp/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: true,
  target: "es2022",
  // Bundle @modelcontextprotocol/sdk and zod into the output
  // so the MCP server is self-contained (no node_modules needed)
  noExternal: [/@modelcontextprotocol/, /zod/],
});
