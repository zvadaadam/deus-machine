const platform = process.argv[2] || "this platform";

console.error(
  [
    `Packaged Deus native runtime is currently staged only for macOS; ${platform} desktop packaging is disabled.`,
    "Do not ship a packaged desktop app for an unstaged platform until Resources/bin/deus-runtime and bundled native agent CLIs are built and verified for that platform.",
    "Use `bun run package:mac` for the currently supported packaged desktop target.",
  ].join("\n")
);
process.exitCode = 1;
