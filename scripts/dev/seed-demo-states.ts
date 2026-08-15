/**
 * Seed a demo database exercising every sidebar workspace state:
 * PR lifecycle (local / draft / open / changes-requested / conflicts /
 * merged / closed), agent activity (working / needs-response / error),
 * manual workflow overrides (backlog / canceled), and initializing.
 *
 * Usage:
 *   bun scripts/dev/seed-demo-states.ts
 *   DATABASE_PATH=.context/demo-deus.db bun run dev:web
 *
 * Writes to .context/demo-deus.db (never the real deus.db) and creates a
 * throwaway git repo at .context/demo-repo so git-backed code paths have a
 * real directory to point at.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { SCHEMA_SQL } from "../../shared/schema";

const ROOT = path.resolve(import.meta.dir, "../..");
const DEMO_DIR = path.join(ROOT, ".context");
const DB_PATH = path.join(DEMO_DIR, "demo-deus.db");
const REPO_PATH = path.join(DEMO_DIR, "demo-repo");

// Fresh demo repo (real git dir so path-based code doesn't trip)
if (!existsSync(path.join(REPO_PATH, ".git"))) {
  mkdirSync(REPO_PATH, { recursive: true });
  execSync("git init -q -b main", { cwd: REPO_PATH });
  writeFileSync(path.join(REPO_PATH, "README.md"), "# Demo repo for sidebar states\n");
  execSync("git add . && git -c user.email=demo@deus.local -c user.name=Demo commit -qm init", {
    cwd: REPO_PATH,
  });
}

// Fresh DB every run
for (const suffix of ["", "-wal", "-shm"]) rmSync(DB_PATH + suffix, { force: true });
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(SCHEMA_SQL);

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString().replace("T", " ").slice(0, 19);

const REPO_ID = "demo-repo-0000";
db.prepare(
  `INSERT INTO repositories (id, name, root_path, git_default_branch, sort_order, git_origin_url, updated_at)
   VALUES (?, ?, ?, 'main', 0, 'https://github.com/deus-machine/demo-states', ?)`
).run(REPO_ID, "demo-states", REPO_PATH, now());

interface SeedWorkspace {
  slug: string;
  title: string | null;
  state?: string;
  status?: string;
  init_stage?: string | null;
  session?: "working" | "needs_response" | "error" | "idle";
  minutes_ago?: number;
  pr?: {
    state: "open" | "merged" | "closed";
    draft?: boolean;
    review?: "approved" | "changes_requested" | "review_required" | "none";
    conflicts?: boolean;
    ci?: "passing" | "failing" | "pending";
  };
}

const seeds: SeedWorkspace[] = [
  // Activity layer on top of PR lifecycle
  {
    slug: "luna-9",
    title: "Auth flow for mobile",
    session: "working",
    minutes_ago: 4,
    pr: { state: "open", draft: true, ci: "pending" },
  },
  {
    slug: "vega-3",
    title: "Single-line sidebar rows",
    session: "needs_response",
    minutes_ago: 12,
    pr: { state: "open", review: "approved", ci: "passing" },
  },
  {
    slug: "orion-2",
    title: "Refactor query invalidation",
    session: "error",
    minutes_ago: 30,
    pr: { state: "open", review: "changes_requested", ci: "failing" },
  },
  // Pure lifecycle states (idle agent)
  {
    slug: "rhea-1",
    title: "Workspace archive flow",
    minutes_ago: 45,
    pr: { state: "open", conflicts: true, ci: "passing" },
  },
  {
    slug: "iapetus-4",
    title: "Add PR status checks",
    minutes_ago: 90,
    pr: { state: "open", review: "review_required", ci: "passing" },
  },
  {
    slug: "titan-8",
    title: "Fix onboarding crash",
    status: "done",
    minutes_ago: 200,
    pr: { state: "merged", review: "approved", ci: "passing" },
  },
  { slug: "callisto-5", title: "Spike: local models", minutes_ago: 300, pr: { state: "closed" } },
  { slug: "milky-way-2", title: null, minutes_ago: 1500 },
  // Manual workflow overrides keep their glyphs
  { slug: "phobos-6", title: "Terminal multiplexer", status: "backlog", minutes_ago: 2000 },
  { slug: "deimos-7", title: "Old spike, abandoned", status: "canceled", minutes_ago: 3000 },
  // Setting-up shimmer row
  {
    slug: "europa-3",
    title: null,
    state: "initializing",
    init_stage: "dependencies",
    minutes_ago: 0,
  },
];

const insertWorkspace = db.prepare(
  `INSERT INTO workspaces (
     id, repository_id, slug, title, git_branch, git_target_branch, state, status,
     current_session_id, pr_url, pr_number, pr_state, pr_is_draft, pr_review_status,
     pr_has_conflicts, pr_ci_status, pr_checked_at, setup_status, init_stage, updated_at
   ) VALUES (?, ?, ?, ?, ?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`
);
const insertSession = db.prepare(
  `INSERT INTO sessions (id, workspace_id, agent_harness, title, status, message_count, last_user_message_at, updated_at)
   VALUES (?, ?, 'claude-code', ?, ?, 3, ?, ?)`
);

let prNumber = 100;
for (const [i, seed] of seeds.entries()) {
  const wsId = `demo-ws-${String(i).padStart(3, "0")}`;
  const updatedAt = minutesAgo(seed.minutes_ago ?? 0);
  const sessionStatus = seed.session ?? "idle";
  const hasSession = seed.state !== "initializing";
  const sessionId = hasSession ? `demo-session-${String(i).padStart(3, "0")}` : null;
  const pr = seed.pr;

  insertWorkspace.run(
    wsId,
    REPO_ID,
    seed.slug,
    seed.title,
    `demo/${seed.slug}`,
    seed.state ?? "ready",
    seed.status ?? "in-progress",
    sessionId,
    pr ? `https://github.com/deus-machine/demo-states/pull/${prNumber}` : null,
    pr ? prNumber : null,
    pr?.state ?? null,
    pr?.draft ? 1 : 0,
    pr?.review ?? null,
    pr?.conflicts ? 1 : 0,
    pr?.ci ?? null,
    pr ? now() : null,
    seed.init_stage ?? null,
    updatedAt
  );

  if (sessionId) {
    // Full ISO (with Z) — matches message-writer's new Date().toISOString(),
    // which useWorkingDuration parses. SQLite-style strings would read as local time.
    const lastUserMessageAt = new Date(Date.now() - (seed.minutes_ago ?? 0) * 60_000).toISOString();
    insertSession.run(
      sessionId,
      wsId,
      seed.title ?? seed.slug,
      sessionStatus,
      lastUserMessageAt,
      updatedAt
    );
  }
  if (pr) prNumber++;
}

// Live in-flight tool call for the working workspace (luna-9) so the sidebar
// hover card's activity line has something to show.
const workingSessionId = "demo-session-000";
const msgId = "demo-msg-tool-000";
db.prepare(
  `INSERT INTO messages (id, session_id, role, content, sent_at) VALUES (?, ?, 'assistant', '', ?)`
).run(msgId, workingSessionId, new Date().toISOString());
db.prepare(
  `INSERT INTO parts (id, message_id, session_id, seq, type, data, tool_call_id, tool_name)
   VALUES (?, ?, ?, 0, 'TOOL', ?, 'demo-tool-call-0', 'Bash')`
).run(
  "demo-part-000",
  msgId,
  workingSessionId,
  JSON.stringify({
    type: "TOOL",
    id: "demo-part-000",
    sessionId: workingSessionId,
    messageId: msgId,
    partIndex: 0,
    toolCallId: "demo-tool-call-0",
    toolName: "Bash",
    title: "bun run test:backend",
    state: { status: "RUNNING", time: { start: new Date().toISOString() } },
  })
);

db.close();
console.log(`Seeded ${seeds.length} workspaces into ${DB_PATH}`);
console.log(`Demo repo at ${REPO_PATH}`);
console.log(`Run:  DATABASE_PATH=${path.relative(ROOT, DB_PATH)} bun run dev:web`);
