import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/index": "src/cli/index.ts",
    "mcp/server": "src/mcp/server.ts",
    "mcp/bin": "src/mcp/bin.ts",
  },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts", "mcp/server": "src/mcp/server.ts" } },
  sourcemap: true,
  clean: true,
  splitting: true,
  target: "node22",
  // Runtime dependencies stay external: bundling the MCP SDK's types into the
  // declarations is what exhausted memory in the earlier build.
  external: ["@napi-rs/canvas"],
});
