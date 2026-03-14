/**
 * Onboarding types — shared between frontend and backend.
 */

/** A recently opened project discovered from Cursor, VSCode, or Claude */
export interface RecentProject {
  path: string;
  name: string;
  source: "cursor" | "vscode" | "claude";
}
