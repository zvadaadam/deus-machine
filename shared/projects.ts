/** Local Projects contract. Execution history continues to use sessions and turns. */
export type ProjectStatus =
  | "preparing"
  | "working"
  | "queued"
  | "idle"
  | "ready"
  | "done"
  | "paused"
  | "needs-attention"
  | "limit-reached"
  | "archived";
export type ProjectToolOperation =
  | "create_agent"
  | "get_agent_status"
  | "read_agent_transcript"
  | "send_to_agent"
  | "report_result"
  | "stop_agent"
  | "publish_context";
export interface ProjectSummary {
  id: string;
  title: string;
  repositoryId: string;
  repositoryName: string;
  coordinatorAgentId: string | null;
  coordinatorSessionId: string | null;
  status: ProjectStatus;
  model: string;
  paused: boolean;
  agentCount: number;
  activeAgentCount: number;
  reportCount: number;
  dispatchCount: number;
  dispatchLimit: number;
  concurrencyLimit: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}
export interface ProjectAgent {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  title: string;
  role: "coordinator" | "contributor";
  status: "preparing" | "working" | "queued" | "idle" | "paused" | "stopping" | "needs-attention";
  assignmentId: string;
  task: string;
  error: string | null;
  paused: boolean;
  canRetry?: boolean;
}
/** Tool-only execution references come from the backend's local workspace metadata. */
export interface ProjectAgentStatusResult {
  agents: Array<
    ProjectAgent & {
      execution: { kind: "local"; workspacePath: string; branch: string | null } | null;
    }
  >;
  remainingTurns: number;
}
export interface ProjectTranscriptResult {
  sessionId: string | null;
  transcript: string;
  truncated: boolean;
  /** Pass as beforeMessageId to read older messages in this same conversation. */
  nextBeforeMessageId: string | null;
}
export interface ProjectFile {
  path: string;
  hash: string;
  size: number;
}
export interface ProjectReport {
  id: string;
  agentId: string;
  agentTitle: string;
  assignmentId: string;
  sessionId: string;
  turnId: string;
  summary: string;
  files: ProjectFile[];
  pullRequests: string[];
  revision: number;
  createdAt: number;
  accepted: boolean;
  ready?: boolean;
}
export interface ProjectPullRequest {
  id: string;
  url: string;
  number: number;
  repository: string;
  title: string | null;
  state: "open" | "closed" | "merged" | null;
  isDraft: boolean | null;
  reviewStatus: string | null;
  ciStatus: string | null;
  hasConflicts: boolean | null;
  /** No checkedAt means a reported link has not been verified by a GitHub lookup. */
  checkedAt: number | null;
  agentIds: string[];
  sources: Array<{
    id: string;
    kind: "report" | "workspace";
    reportId: string | null;
    assignmentId: string | null;
    agentId: string;
    sessionId: string | null;
    turnId: string | null;
    originalUrl: string;
  }>;
}
export interface ProjectDetail extends ProjectSummary {
  brief: string;
  contentRevision: number;
  files: ProjectFile[];
  agents: ProjectAgent[];
  reports: ProjectReport[];
  pendingInputCount: number;
  pendingMessageCount: number;
  pendingMessages: Array<{ id: string; agentId: string; message: string; createdAt: number }>;
  pullRequests?: ProjectPullRequest[];
}
export interface CreateProjectInput {
  requestId: string;
  title: string;
  /** May be empty: the coordinator then opens with a welcome and the first instruction becomes the brief. */
  brief: string;
  repositoryId: string;
  model: string;
  concurrencyLimit?: number;
  dispatchLimit?: number;
}
