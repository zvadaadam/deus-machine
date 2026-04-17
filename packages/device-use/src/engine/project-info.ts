// Xcode project introspection — wraps `xcodebuild -list -json`.
// Used by the agent to discover schemes / targets / configurations for a project.

import type { CommandExecutor, ExecOptions } from "./types.js";
import { DeviceUseError } from "./errors.js";

export interface ProjectInfo {
  name: string;
  schemes: string[];
  targets: string[];
  configurations: string[];
  /** "xcodeproj" | "workspace" — derived from the path extension */
  kind: "xcodeproj" | "workspace";
  path: string;
}

interface XcodebuildListOutput {
  project?: {
    name: string;
    schemes?: string[];
    targets?: string[];
    configurations?: string[];
  };
  workspace?: {
    name: string;
    schemes?: string[];
  };
}

export class XcodebuildError extends DeviceUseError {
  constructor(
    message: string,
    readonly exitCode?: number,
    readonly stderr?: string
  ) {
    super(message);
  }
}

function detectKind(projectPath: string): "xcodeproj" | "workspace" {
  if (projectPath.endsWith(".xcworkspace")) return "workspace";
  return "xcodeproj";
}

/**
 * Returns schemes / targets / configurations for an Xcode project or workspace.
 *
 * @param executor Injectable for tests — defaults to the concrete `createExecutor()` wrapper.
 * @param projectPath Absolute path to a `.xcodeproj` or `.xcworkspace`.
 */
export async function getProjectInfo(
  executor: CommandExecutor,
  projectPath: string,
  opts?: ExecOptions
): Promise<ProjectInfo> {
  const kind = detectKind(projectPath);
  const flag = kind === "workspace" ? "-workspace" : "-project";
  const result = await executor(["xcodebuild", "-list", "-json", flag, projectPath], opts);

  if (!result.success) {
    throw new XcodebuildError(
      `xcodebuild -list failed for ${projectPath}`,
      result.exitCode,
      result.error
    );
  }

  let parsed: XcodebuildListOutput;
  try {
    parsed = JSON.parse(result.output) as XcodebuildListOutput;
  } catch (err) {
    throw new XcodebuildError(`Failed to parse xcodebuild -list output: ${(err as Error).message}`);
  }

  const source = parsed.project ?? parsed.workspace;
  if (!source) {
    throw new XcodebuildError("xcodebuild -list returned no project or workspace data");
  }

  return {
    name: source.name,
    schemes: parsed.project?.schemes ?? parsed.workspace?.schemes ?? [],
    targets: parsed.project?.targets ?? [],
    configurations: parsed.project?.configurations ?? [],
    kind,
    path: projectPath,
  };
}
