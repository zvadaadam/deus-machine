/**
 * Manifest types — shared between frontend and backend.
 *
 * NormalizedTask is the resolved form of a task entry from deus.json
 * (string shorthand expanded to full object). Used by manifest endpoints
 * on both sides.
 */

/** A task from deus.json, normalized to full object form */
export interface NormalizedTask {
  name: string;
  command: string;
  description: string | null;
  icon: string;
  persistent: boolean;
  mode: "concurrent" | "nonconcurrent";
  depends: string[];
  env: Record<string, string>;
}

/** Response from manifest endpoints (GET /repos/:id/manifest, GET /workspaces/:id/manifest) */
export interface ManifestResponse {
  manifest: Record<string, unknown> | null;
  tasks: NormalizedTask[];
}

/** Response from POST /workspaces/:id/tasks/:name/run */
export interface TaskRunResponse {
  ptyId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  persistent: boolean;
  mode: "concurrent" | "nonconcurrent";
}
