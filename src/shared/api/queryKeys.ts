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
    all: ['workspaces'] as const,
    byRepo: (state?: string) => ['workspaces', 'by-repo', state] as const,
    detail: (id: string) => ['workspaces', 'detail', id] as const,
    diffStats: (id: string) => ['workspaces', 'diff-stats', id] as const,
    diffFiles: (id: string) => ['workspaces', 'diff-files', id] as const,
    diffFile: (id: string, file: string) => ['workspaces', 'diff-file', id, file] as const,
    prStatus: (id: string) => ['workspaces', 'pr-status', id] as const,
    devServers: (id: string) => ['workspaces', 'dev-servers', id] as const,
  },

  // Sessions
  sessions: {
    all: ['sessions'] as const,
    detail: (id: string) => ['sessions', 'detail', id] as const,
    messages: (id: string) => ['sessions', 'messages', id] as const,
  },

  // Repositories
  repos: {
    all: ['repos'] as const,
    detail: (id: string) => ['repos', 'detail', id] as const,
  },

  // Stats
  stats: {
    all: ['stats'] as const,
  },

  // Settings
  settings: {
    all: ['settings'] as const,
    mcpServers: ['settings', 'mcp-servers'] as const,
    commands: ['settings', 'commands'] as const,
    agents: ['settings', 'agents'] as const,
    hooks: ['settings', 'hooks'] as const,
  },
} as const;
