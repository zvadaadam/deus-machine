export function getCliCommand(args: string[]): string | null {
  return args[0] && !args[0].startsWith("-") ? args[0] : null;
}

export function isGlobalVersionRequest(args: string[]): boolean {
  const command = getCliCommand(args);
  if (command) return false;
  return args.includes("--version") || args.includes("-v");
}
