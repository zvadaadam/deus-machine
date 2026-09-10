import type { ProjectEnvironment } from "@deus-hq/api";

export interface ProjectTask {
  name: string;
  command: string;
}

export interface ProjectEnvironmentResponse {
  project: ProjectEnvironment | null;
  source: "repository" | "settings" | "unconfigured";
  branch?: string;
  tasks: ProjectTask[];
}

/** Only public command data crosses the UI boundary. Credentials stay on the executing node. */
export interface TaskRunResponse {
  command: string;
}
