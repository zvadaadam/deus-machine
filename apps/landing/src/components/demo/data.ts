export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'cta'
  content: string
}

export interface Workspace {
  id: string
  name: string
  repo: string
  status: 'active' | 'pending' | 'idle'
  time?: string
  messages: Message[]
  diff?: { file: string; add: number; del: number }
  browserUrl?: string
}

export const WORKSPACES: Workspace[] = [
  {
    id: 'auth',
    name: 'feat/auth-flow',
    repo: 'box-ide',
    status: 'active',
    time: '2m',
    messages: [
      { role: 'user', content: 'Add error handling to the auth middleware' },
      { role: 'assistant', content: "I'll add try-catch blocks around the token verification and session validation. Let me also add proper error responses with status codes..." },
      { role: 'tool', content: 'Editing auth/middleware.ts' },
    ],
    diff: { file: 'auth/middleware.ts', add: 24, del: 3 },
    browserUrl: 'localhost:1420/settings',
  },
  {
    id: 'sidebar',
    name: 'fix/sidebar-bug',
    repo: 'box-ide',
    status: 'pending',
    messages: [
      { role: 'user', content: 'The sidebar collapses on hover instead of click' },
      { role: 'assistant', content: "Found it — the hover listener on SidebarTrigger is conflicting with the click handler. I'll remove the mouseenter event and keep only the button click..." },
      { role: 'tool', content: 'Editing sidebar/trigger.tsx' },
    ],
    diff: { file: 'sidebar/trigger.tsx', add: 8, del: 12 },
    browserUrl: 'localhost:1420',
  },
  {
    id: 'refactor',
    name: 'refactor/api',
    repo: 'box-ide',
    status: 'idle',
    messages: [
      { role: 'user', content: 'Extract the query builder into a shared utility' },
      { role: 'assistant', content: "I've created a new QueryBuilder class in shared/lib/query-builder.ts. It handles parameter binding, pagination, and supports both SQLite and the test mock. Migrating the 4 route files now..." },
    ],
    diff: { file: 'shared/lib/query-builder.ts', add: 156, del: 0 },
  },
  {
    id: 'caching',
    name: 'add-caching',
    repo: 'api-server',
    status: 'active',
    messages: [
      { role: 'user', content: 'Add Redis caching for the /users endpoint' },
      { role: 'assistant', content: "I'll set up a cache-aside pattern with a 5-minute TTL. The cache key will include the query parameters so filtered requests get separate entries..." },
      { role: 'tool', content: 'Editing routes/users.ts' },
    ],
    diff: { file: 'routes/users.ts', add: 42, del: 5 },
    browserUrl: 'localhost:3001/users',
  },
  {
    id: 'perf',
    name: 'perf/queries',
    repo: 'api-server',
    status: 'idle',
    messages: [
      { role: 'user', content: 'Profile the slow dashboard query and optimize it' },
      { role: 'assistant', content: 'The main bottleneck is a missing index on sessions.workspace_id. After adding it, the query dropped from 340ms to 12ms. I also replaced the correlated subquery with a JOIN...' },
    ],
    diff: { file: 'services/dashboard.ts', add: 18, del: 31 },
  },
]

const AGENT_REPLIES: Record<string, string> = {
  default: "I'll look into that. Let me analyze the code and find the best approach...",
  fix: "Found the issue. Let me write a fix and run the tests to make sure nothing breaks...",
  add: "Good idea. I'll implement that feature. Starting with the type definitions, then the UI...",
  test: "I'll write tests for this. Setting up the test fixtures first, then covering the edge cases...",
  refactor: "I'll clean that up. Moving the shared logic into a utility module and updating all the import sites...",
}

export function getAgentReply(input: string): string {
  const lower = input.toLowerCase()
  if (lower.includes('fix') || lower.includes('bug')) return AGENT_REPLIES.fix
  if (lower.includes('add') || lower.includes('create') || lower.includes('implement')) return AGENT_REPLIES.add
  if (lower.includes('test')) return AGENT_REPLIES.test
  if (lower.includes('refactor') || lower.includes('clean') || lower.includes('extract')) return AGENT_REPLIES.refactor
  return AGENT_REPLIES.default
}
