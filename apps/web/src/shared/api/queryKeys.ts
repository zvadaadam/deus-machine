/**
 * Query Keys Factory
 * Type-safe, hierarchical query keys for TanStack Query
 *
 * Pattern: [scope, ...identifiers, ...filters]
 * Benefits:
 * - Easy invalidation (invalidate all workspaces with ['workspaces'])
 * - Prevents cache collisions
 * - Autocomplete support
 */

export const queryKeys = {
  // Workspaces
  workspaces: {
    all: ["workspaces"] as const,
    byRepo: (state?: string) => ["workspaces", "by-repo", state] as const,
    detail: (id: string) => ["workspaces", "detail", id] as const,
    diffStats: (id: string) => ["workspaces", "diff-stats", id] as const,
    diffFiles: (id: string) => ["workspaces", "diff-files", id] as const,
    diffFile: (id: string, file: string) => ["workspaces", "diff-file", id, file] as const,
    prStatus: (id: string) => ["workspaces", "pr-status", id] as const,
    systemPrompt: (id: string) => ["workspaces", "system-prompt", id] as const,
    environment: (id: string) => ["workspaces", "environment", id] as const,
  },

  // Sessions
  sessions: {
    all: ["sessions"] as const,
    detail: (id: string) => ["sessions", "detail", id] as const,
    messages: (id: string) => ["sessions", "messages", id] as const,
    byWorkspace: (workspaceId: string) => ["sessions", "by-workspace", workspaceId] as const,
  },

  // Repositories
  repos: {
    all: ["repos"] as const,
    detail: (id: string) => ["repos", "detail", id] as const,
    environment: (id: string) => ["repos", "environment", id] as const,
    prs: (repoId: string) => ["repos", repoId, "prs"] as const,
    branches: (repoId: string) => ["repos", repoId, "branches"] as const,
  },

  // Stats
  stats: {
    all: ["stats"] as const,
  },

  // GitHub CLI
  github: {
    ghStatus: ["github", "gh-status"] as const,
  },

  // Deus Cloud account
  deusCloud: {
    session: ["deus-cloud", "session"] as const,
  },

  // AI Provider Status (external health monitoring)
  providerStatus: {
    all: ["provider-status"] as const,
    detail: (providerId: string) => ["provider-status", "detail", providerId] as const,
  },

  // Settings
  settings: {
    all: ["settings"] as const,
    mcpServers: ["settings", "mcp-servers"] as const,
    commands: ["settings", "commands"] as const,
    agents: ["settings", "agents"] as const,
    agentAuth: ["settings", "agent-auth"] as const,
    environments: {
      all: ["settings", "environment-secrets"] as const,
      organizations: (accountId: string | null) =>
        ["settings", "environment-secrets", accountId, "orgs"] as const,
      detail: (accountId: string | null, orgId: string | null, environmentId: string | null) =>
        ["settings", "environment-secrets", accountId, orgId, environmentId] as const,
      repositories: (accountId: string | null, orgId: string | null) =>
        ["settings", "environment-secrets", accountId, orgId, "github-repos"] as const,
      repositoryFile: (accountId: string | null, orgId: string | null, repositoryKey: string) =>
        ["settings", "environment-secrets", accountId, orgId, "file", repositoryKey] as const,
      installation: (accountId: string, orgId: string) =>
        ["settings", "environment-secrets", accountId, orgId, "github-install"] as const,
    },
  },

  // Agent Config (scope-aware config management)
  agentConfig: {
    all: ["agent-config"] as const,
    category: (cat: string, scope: string, repoPath?: string) =>
      ["agent-config", cat, scope, repoPath] as const,
  },
} as const;
