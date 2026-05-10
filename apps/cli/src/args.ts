export function getCliCommandIndex(args: string[]): number {
  return args.findIndex((arg) => !arg.startsWith("-"));
}

export function getCliCommand(args: string[]): string | null {
  const commandIndex = getCliCommandIndex(args);
  return commandIndex === -1 ? null : args[commandIndex];
}

export function isGlobalVersionRequest(args: string[]): boolean {
  if (getCliCommandIndex(args) !== -1) return false;
  return args.includes("--version") || args.includes("-v");
}
