// gateway/clients/backend.ts
// Thin HTTP client for the OpenDevs backend REST API.

export class BackendClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /** List all repos */
  async listRepos(): Promise<Array<{ id: string; name: string; root_path: string }>> {
    return this.get("/api/repos");
  }

  /** List workspaces grouped by repo */
  async listWorkspacesByRepo(): Promise<
    Array<{
      repo_id: string;
      repo_name: string;
      workspaces: Array<{
        id: string;
        name: string;
        state: string;
        workspace_path: string;
      }>;
    }>
  > {
    return this.get("/api/workspaces/by-repo");
  }

  /** Get a specific workspace */
  async getWorkspace(id: string): Promise<{
    id: string;
    name: string;
    state: string;
    workspace_path: string;
    repository_id: string;
  }> {
    return this.get(`/api/workspaces/${id}`);
  }

  /** List sessions for a workspace */
  async listSessions(workspaceId: string): Promise<
    Array<{
      id: string;
      workspace_id: string;
      status: string;
      title: string | null;
      agent_type: string;
    }>
  > {
    return this.get(`/api/workspaces/${workspaceId}/sessions`);
  }

  /** Get a specific session */
  async getSession(sessionId: string): Promise<{
    id: string;
    workspace_id: string;
    status: string;
    title: string | null;
    agent_type: string;
  }> {
    return this.get(`/api/sessions/${sessionId}`);
  }

  /** Save a user message and trigger agent processing */
  async sendMessage(
    sessionId: string,
    content: string,
    model?: string
  ): Promise<{
    id: string;
    session_id: string;
    role: string;
    content: string;
  }> {
    return this.post(`/api/sessions/${sessionId}/messages`, { content, model });
  }

  /** Stop an active agent session */
  async stopSession(sessionId: string): Promise<{
    success: boolean;
    message: string;
  }> {
    return this.post(`/api/sessions/${sessionId}/stop`, {});
  }

  /** Get diff stats for a workspace */
  async getDiffStats(workspaceId: string): Promise<{
    additions: number;
    deletions: number;
    files_changed: number;
  }> {
    return this.get(`/api/workspaces/${workspaceId}/diff-stats`);
  }

  /** Create a new session for a workspace */
  async createSession(workspaceId: string): Promise<{
    id: string;
    workspace_id: string;
    status: string;
    agent_type: string;
  }> {
    return this.post(`/api/workspaces/${workspaceId}/sessions`, {});
  }

  // ---- Internal helpers ----

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Backend GET ${path} failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Backend POST ${path} failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<T>;
  }
}
