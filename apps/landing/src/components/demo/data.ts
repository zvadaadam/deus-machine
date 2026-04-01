export interface Message {
  role: "user" | "assistant" | "tool" | "cta";
  content: string;
}

export interface DiffLine {
  type: "add" | "del" | "ctx";
  content: string;
}

export interface DiffFile {
  file: string;
  add: number;
  del: number;
  lines: DiffLine[];
}

export interface Workspace {
  id: string;
  name: string;
  repo: string;
  status: "active" | "pending" | "idle";
  time?: string;
  messages: Message[];
  diff?: DiffFile;
  browserUrl?: string;
}

export const WORKSPACES: Workspace[] = [
  {
    id: "auth",
    name: "feat/auth-flow",
    repo: "box-ide",
    status: "active",
    time: "2m",
    messages: [
      { role: "user", content: "Add error handling to the auth middleware" },
      {
        role: "assistant",
        content:
          "I'll add try-catch blocks around the token verification and session validation. Let me also add proper error responses with status codes...",
      },
      { role: "tool", content: "Editing auth/middleware.ts" },
    ],
    diff: {
      file: "auth/middleware.ts",
      add: 24,
      del: 3,
      lines: [
        { type: "ctx", content: "export async function authMiddleware(c: Context, next: Next) {" },
        { type: "del", content: "  // TODO: add auth" },
        { type: "del", content: "  await next()" },
        { type: "add", content: "  try {" },
        { type: "add", content: '    const token = c.req.header("Authorization")?.split(" ")[1]' },
        { type: "add", content: '    if (!token) return c.json({ error: "Unauthorized" }, 401)' },
        { type: "add", content: "    const session = await verifyToken(token)" },
        { type: "add", content: '    c.set("session", session)' },
        { type: "add", content: "    await next()" },
        { type: "add", content: "  } catch (err) {" },
        { type: "add", content: '    return c.json({ error: "Invalid token" }, 403)' },
        { type: "add", content: "  }" },
        { type: "ctx", content: "}" },
      ],
    },
    browserUrl: "localhost:1420/settings",
  },
  {
    id: "sidebar",
    name: "fix/sidebar-bug",
    repo: "box-ide",
    status: "pending",
    messages: [
      { role: "user", content: "The sidebar collapses on hover instead of click" },
      {
        role: "assistant",
        content:
          "Found it — the hover listener on SidebarTrigger is conflicting with the click handler. I'll remove the mouseenter event and keep only the button click...",
      },
      { role: "tool", content: "Editing sidebar/trigger.tsx" },
    ],
    diff: {
      file: "sidebar/trigger.tsx",
      add: 8,
      del: 12,
      lines: [
        { type: "ctx", content: "export function SidebarTrigger() {" },
        { type: "del", content: "  const handleMouseEnter = () => {" },
        { type: "del", content: "    setCollapsed(!collapsed)" },
        { type: "del", content: "  }" },
        { type: "ctx", content: "" },
        { type: "add", content: "  const handleClick = useCallback(() => {" },
        { type: "add", content: "    setCollapsed(prev => !prev)" },
        { type: "add", content: "  }, [])" },
        { type: "ctx", content: "" },
        { type: "ctx", content: "  return (" },
        { type: "del", content: "    <button onMouseEnter={handleMouseEnter}>" },
        { type: "add", content: "    <button onClick={handleClick}>" },
      ],
    },
    browserUrl: "localhost:1420",
  },
  {
    id: "refactor",
    name: "refactor/api",
    repo: "box-ide",
    status: "idle",
    messages: [
      { role: "user", content: "Extract the query builder into a shared utility" },
      {
        role: "assistant",
        content:
          "I've created a new QueryBuilder class in shared/lib/query-builder.ts. It handles parameter binding, pagination, and supports both SQLite and the test mock. Migrating the 4 route files now...",
      },
    ],
    diff: {
      file: "shared/lib/query-builder.ts",
      add: 156,
      del: 0,
      lines: [
        { type: "add", content: "export class QueryBuilder {" },
        { type: "add", content: "  private table: string" },
        { type: "add", content: "  private conditions: string[] = []" },
        { type: "add", content: "  private params: unknown[] = []" },
        { type: "add", content: "" },
        { type: "add", content: "  constructor(table: string) {" },
        { type: "add", content: "    this.table = table" },
        { type: "add", content: "  }" },
        { type: "add", content: "" },
        { type: "add", content: "  where(col: string, val: unknown) {" },
        { type: "add", content: "    this.conditions.push(`${col} = ?`)" },
        { type: "add", content: "    this.params.push(val)" },
        { type: "add", content: "    return this" },
        { type: "add", content: "  }" },
      ],
    },
  },
  {
    id: "caching",
    name: "add-caching",
    repo: "api-server",
    status: "active",
    messages: [
      { role: "user", content: "Add Redis caching for the /users endpoint" },
      {
        role: "assistant",
        content:
          "I'll set up a cache-aside pattern with a 5-minute TTL. The cache key will include the query parameters so filtered requests get separate entries...",
      },
      { role: "tool", content: "Editing routes/users.ts" },
    ],
    diff: {
      file: "routes/users.ts",
      add: 42,
      del: 5,
      lines: [
        { type: "ctx", content: 'app.get("/users", async (c) => {' },
        {
          type: "add",
          content: '  const cacheKey = `users:${c.req.query("page")}:${c.req.query("q")}`',
        },
        { type: "add", content: "  const cached = await redis.get(cacheKey)" },
        { type: "add", content: "  if (cached) return c.json(JSON.parse(cached))" },
        { type: "ctx", content: "" },
        { type: "del", content: '  const users = await db.query("SELECT * FROM users")' },
        {
          type: "add",
          content:
            '  const users = await db.query("SELECT * FROM users LIMIT ? OFFSET ?", [limit, offset])',
        },
        { type: "add", content: "  await redis.setex(cacheKey, 300, JSON.stringify(users))" },
        { type: "ctx", content: "  return c.json(users)" },
        { type: "ctx", content: "})" },
      ],
    },
    browserUrl: "localhost:3001/users",
  },
  {
    id: "perf",
    name: "perf/queries",
    repo: "api-server",
    status: "idle",
    messages: [
      { role: "user", content: "Profile the slow dashboard query and optimize it" },
      {
        role: "assistant",
        content:
          "The main bottleneck is a missing index on sessions.workspace_id. After adding it, the query dropped from 340ms to 12ms. I also replaced the correlated subquery with a JOIN...",
      },
    ],
    diff: {
      file: "services/dashboard.ts",
      add: 18,
      del: 31,
      lines: [
        { type: "del", content: "  const sessions = await db.query(`" },
        { type: "del", content: "    SELECT s.*, (SELECT MAX(sent_at) FROM messages" },
        { type: "del", content: "    WHERE session_id = s.id) as last_message" },
        { type: "del", content: "    FROM sessions s WHERE workspace_id = ?`)" },
        { type: "add", content: "  const sessions = await db.query(`" },
        { type: "add", content: "    SELECT s.*, m.max_sent as last_message FROM sessions s" },
        { type: "add", content: "    LEFT JOIN (SELECT session_id, MAX(sent_at) as max_sent" },
        { type: "add", content: "      FROM messages GROUP BY session_id) m" },
        { type: "add", content: "    ON m.session_id = s.id WHERE s.workspace_id = ?`)" },
      ],
    },
  },
];

const AGENT_REPLIES: Record<string, string> = {
  default: "I'll look into that. Let me analyze the code and find the best approach...",
  fix: "Found the issue. Let me write a fix and run the tests to make sure nothing breaks...",
  add: "Good idea. I'll implement that feature. Starting with the type definitions, then the UI...",
  test: "I'll write tests for this. Setting up the test fixtures first, then covering the edge cases...",
  refactor:
    "I'll clean that up. Moving the shared logic into a utility module and updating all the import sites...",
};

export function getAgentReply(input: string): string {
  const lower = input.toLowerCase();
  if (lower.includes("fix") || lower.includes("bug")) return AGENT_REPLIES.fix;
  if (lower.includes("add") || lower.includes("create") || lower.includes("implement"))
    return AGENT_REPLIES.add;
  if (lower.includes("test")) return AGENT_REPLIES.test;
  if (lower.includes("refactor") || lower.includes("clean") || lower.includes("extract"))
    return AGENT_REPLIES.refactor;
  return AGENT_REPLIES.default;
}
