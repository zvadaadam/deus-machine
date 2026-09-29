import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { uuidv7 } from "@shared/lib/uuid";
import type { ProjectPullRequest } from "@shared/projects";
import { ConflictError } from "../../lib/errors";
import type { PrStatusResponse } from "../gh.service";

interface GitHubPullRequest {
  host: string;
  repository: string;
  number: number;
  url: string;
}

/** GitHub web locators only. Repository rename aliases need provider IDs before merging. */
export function parseProjectPullRequest(value: string): GitHubPullRequest | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !["github.com", "www.github.com"].includes(url.hostname)
  )
    return null;
  const match = url.pathname.match(
    /^\/([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/i
  );
  if (!match || [".", ".."].includes(match[2])) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return null;
  const repository = `${match[1]}/${match[2]}`.toLowerCase();
  return {
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
  };
}

function ensureAssociation(
  db: Database.Database,
  projectId: string,
  pr: GitHubPullRequest
): string {
  db.prepare(
    `INSERT INTO project_pull_requests
    (id,project_id,host,repository,pr_number,canonical_url,linked_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(project_id,host,repository,pr_number) DO NOTHING`
  ).run(uuidv7(), projectId, pr.host, pr.repository, pr.number, pr.url, Date.now());
  return (
    db
      .prepare(
        `SELECT id FROM project_pull_requests
    WHERE project_id=? AND host=? AND repository=? AND pr_number=?`
      )
      .get(projectId, pr.host, pr.repository, pr.number) as { id: string }
  ).id;
}

interface Source {
  projectId: string;
  linkId: string;
  reportId: string | null;
  assignmentId: string | null;
  agentId: string;
  sessionId: string | null;
  turnId: string | null;
  relation: "report" | "workspace";
  originalUrl: string;
  dedupKey: string;
}
function recordSource(db: Database.Database, source: Source): string {
  db.prepare(
    `INSERT INTO project_pr_sources
    (id,project_id,pr_link_id,report_id,assignment_id,agent_id,session_id,turn_id,relation,original_url,dedup_key,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,dedup_key) DO NOTHING`
  ).run(
    uuidv7(),
    source.projectId,
    source.linkId,
    source.reportId,
    source.assignmentId,
    source.agentId,
    source.sessionId,
    source.turnId,
    source.relation,
    source.originalUrl,
    source.dedupKey,
    Date.now()
  );
  return (
    db
      .prepare("SELECT id FROM project_pr_sources WHERE project_id=? AND dedup_key=?")
      .get(source.projectId, source.dedupKey) as { id: string }
  ).id;
}

/** Call after the immutable report INSERT, in the same metadata transaction. */
export function captureReportPullRequests(
  db: Database.Database,
  input: {
    projectId: string;
    reportId: string;
    assignmentId: string;
    agentId: string;
    sessionId: string;
    turnId: string;
    urls: string[];
  }
): string[] {
  const report = db
    .prepare(
      `SELECT 1 FROM project_reports WHERE id=? AND project_id=?
    AND assignment_id=? AND agent_id=? AND session_id=? AND turn_id=?`
    )
    .get(
      input.reportId,
      input.projectId,
      input.assignmentId,
      input.agentId,
      input.sessionId,
      input.turnId
    );
  if (!report) throw new ConflictError("PR evidence must match its persisted report source.");
  return db.transaction(() =>
    input.urls.flatMap((originalUrl) => {
      const pr = parseProjectPullRequest(originalUrl);
      // Unsupported locators remain in the report; they are not invented GitHub associations.
      if (!pr) return [];
      const linkId = ensureAssociation(db, input.projectId, pr);
      const locatorHash = createHash("sha256").update(originalUrl).digest("hex");
      return [
        recordSource(db, {
          ...input,
          linkId,
          originalUrl,
          relation: "report",
          dedupKey: `report:${input.reportId}:${locatorHash}`,
        }),
      ];
    })
  )();
}

/** Workspace lookups prove current PR state, not which turn authored the PR. */
export function captureWorkspacePullRequest(
  db: Database.Database,
  workspaceId: string,
  result: PrStatusResponse,
  checkedAt: number
): boolean {
  if (result.error || !result.has_pr || !result.pr_url) return false;
  const pr = parseProjectPullRequest(result.pr_url);
  if (!pr || (result.pr_number !== undefined && result.pr_number !== pr.number)) return false;
  const member = db
    .prepare("SELECT project_id FROM project_agents WHERE agent_id=?")
    .get(workspaceId) as { project_id: string } | undefined;
  if (!member) return false;
  return db.transaction(() => {
    const linkId = ensureAssociation(db, member.project_id, pr);
    recordSource(db, {
      projectId: member.project_id,
      linkId,
      reportId: null,
      assignmentId: null,
      agentId: workspaceId,
      sessionId: null,
      turnId: null,
      relation: "workspace",
      originalUrl: result.pr_url!,
      dedupKey: `workspace:${workspaceId}:${pr.url}`,
    });
    // The lookup's start time prevents a slower, older workspace lookup from
    // overwriting a newer snapshot of the same PR discovered by another Agent.
    db.prepare(
      `UPDATE project_pull_requests SET title=COALESCE(?,title), state=?, is_draft=?,
      review_status=?,ci_status=?,has_conflicts=?,checked_at=?
      WHERE id=? AND (checked_at IS NULL OR checked_at<=?)`
    ).run(
      result.pr_title ?? null,
      result.pr_state ?? null,
      result.is_draft === undefined ? null : Number(result.is_draft),
      result.review_status ?? null,
      result.ci_status ?? null,
      result.has_conflicts === undefined ? null : Number(result.has_conflicts),
      checkedAt,
      linkId,
      checkedAt
    );
    db.prepare("UPDATE projects SET revision=revision+1,updated_at=? WHERE id=?").run(
      Date.now(),
      member.project_id
    );
    return true;
  })();
}

interface LinkRow {
  id: string;
  canonical_url: string;
  repository: string;
  pr_number: number;
  title: string | null;
  state: ProjectPullRequest["state"];
  is_draft: number | null;
  review_status: string | null;
  ci_status: string | null;
  has_conflicts: number | null;
  checked_at: number | null;
}
interface SourceRow {
  id: string;
  pr_link_id: string;
  relation: "report" | "workspace";
  report_id: string | null;
  assignment_id: string | null;
  agent_id: string;
  session_id: string | null;
  turn_id: string | null;
  original_url: string;
}

/** Two batched reads, including provenance; no per-PR network calls or queries. */
export function queryProjectPullRequests(
  db: Database.Database,
  projectId: string
): ProjectPullRequest[] {
  const links = db
    .prepare("SELECT * FROM project_pull_requests WHERE project_id=? ORDER BY linked_at,id")
    .all(projectId) as LinkRow[];
  if (!links.length) return [];
  const rows = db
    .prepare("SELECT * FROM project_pr_sources WHERE project_id=? ORDER BY created_at,id")
    .all(projectId) as SourceRow[];
  const sources = new Map<string, ProjectPullRequest["sources"]>();
  for (const row of rows) {
    const list = sources.get(row.pr_link_id) ?? [];
    list.push({
      id: row.id,
      kind: row.relation,
      reportId: row.report_id,
      assignmentId: row.assignment_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      originalUrl: row.original_url,
    });
    sources.set(row.pr_link_id, list);
  }
  return links.map((row) => {
    const provenance = sources.get(row.id) ?? [];
    return {
      id: row.id,
      url: row.canonical_url,
      repository: row.repository,
      number: row.pr_number,
      title: row.title,
      state: row.state,
      isDraft: row.is_draft === null ? null : row.is_draft === 1,
      reviewStatus: row.review_status,
      ciStatus: row.ci_status,
      hasConflicts: row.has_conflicts === null ? null : row.has_conflicts === 1,
      checkedAt: row.checked_at,
      agentIds: [...new Set(provenance.map((source) => source.agentId))],
      sources: provenance,
    };
  });
}
