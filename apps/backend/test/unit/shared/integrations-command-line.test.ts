import { describe, expect, it } from "vitest";
import { splitCommandLine } from "@shared/integrations/command-line";

describe("a local server's command line", () => {
  it("splits on spaces", () => {
    expect(splitCommandLine("  npx -y  @acme/mcp-server ")).toEqual([
      "npx",
      "-y",
      "@acme/mcp-server",
    ]);
    expect(splitCommandLine("")).toEqual([]);
  });

  it("keeps a quoted path with spaces as one argument, without its quotes", () => {
    expect(splitCommandLine('node "/Users/alice/My Tools/server.js" --port 3000')).toEqual([
      "node",
      "/Users/alice/My Tools/server.js",
      "--port",
      "3000",
    ]);
    expect(splitCommandLine("node '/Users/alice/My Tools/server.js'")).toEqual([
      "node",
      "/Users/alice/My Tools/server.js",
    ]);
    expect(splitCommandLine("node /Users/alice/My\\ Tools/server.js")).toEqual([
      "node",
      "/Users/alice/My Tools/server.js",
    ]);
  });

  it("reads quotes inside a word, escapes inside double quotes, and empty arguments", () => {
    expect(splitCommandLine('server --name="My \\"best\\" server" --empty ""')).toEqual([
      "server",
      '--name=My "best" server',
      "--empty",
      "",
    ]);
    expect(splitCommandLine("echo 'a \\ b'")).toEqual(["echo", "a \\ b"]);
  });

  it("leaves a Windows path as it is", () => {
    expect(splitCommandLine("C:\\Tools\\server.exe --flag")).toEqual([
      "C:\\Tools\\server.exe",
      "--flag",
    ]);
  });

  it("answers null for a quote left open", () => {
    expect(splitCommandLine('node "/Users/alice/My Tools')).toBeNull();
    expect(splitCommandLine("node 'server.js")).toBeNull();
  });
});
