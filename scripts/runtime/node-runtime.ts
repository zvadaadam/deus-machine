export interface ResolveNodeRuntimeCommandOptions {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  versions?: NodeJS.ProcessVersions;
}

/**
 * Native Node addons used by the backend cannot load under Bun. When this
 * launcher itself runs under Bun, start the backend with a real Node runtime.
 */
export function resolveNodeRuntimeCommand(
  options: ResolveNodeRuntimeCommandOptions = {}
): string {
  const env = options.env ?? process.env;
  const override = env.DEUS_NODE_BINARY?.trim();
  if (override) return override;

  const versions = options.versions ?? process.versions;
  const isBun = Boolean((versions as Record<string, string | undefined>).bun);
  if (isBun) return "node";

  return options.execPath ?? process.execPath;
}
