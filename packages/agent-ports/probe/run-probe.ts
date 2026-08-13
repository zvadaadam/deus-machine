// packages/agent-ports/probe/run-probe.ts
// Empirical test harness: run every port against the REAL data on this machine
// and report coverage, fidelity, perf, and limitations. Read-only everywhere;
// DB copies go to /tmp.
//
//   bun packages/agent-ports/probe/run-probe.ts [--full-claude] [--full-codex]
//
// Full parses run on everything by default; flags exist to skip for quick runs
// (--heads-only).

import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as claudeCode from "../src/providers/claude-code.ts";
import * as codex from "../src/providers/codex.ts";
import * as cursor from "../src/providers/cursor.ts";
import type { FullParseStats, PortableSessionHead } from "../src/types.ts";

const HOME = homedir();
const headsOnly = process.argv.includes("--heads-only");

const report: Record<string, unknown> = { generatedAt: new Date().toISOString() };

function fmtBytes(n: number): string {
  if (n > 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
  if (n > 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n > 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function topEntries(histogram: Record<string, number>, n = 15): [string, number][] {
  return Object.entries(histogram)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function mergeHistogram(into: Record<string, number>, from: Record<string, number>): void {
  for (const [key, count] of Object.entries(from)) into[key] = (into[key] ?? 0) + count;
}

function truncate(s: string | undefined, n = 70): string {
  if (!s) return "";
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

interface FullAggregate {
  files: number;
  bytes: number;
  parseMs: number;
  messages: number;
  metaMessages: number;
  parts: Record<string, number>;
  toolNames: Record<string, number>;
  skippedRecordTypes: Record<string, number>;
  unmatchedToolResults: number;
  orphanToolCalls: number;
  sidechainRecords: number;
  sidechainLinked: number;
  compactions: number;
  parseErrors: number;
  failures: { file: string; error: string }[];
  slowest: { file: string; ms: number; bytes: number }[];
}

function newAggregate(): FullAggregate {
  return {
    files: 0,
    bytes: 0,
    parseMs: 0,
    messages: 0,
    metaMessages: 0,
    parts: {},
    toolNames: {},
    skippedRecordTypes: {},
    unmatchedToolResults: 0,
    orphanToolCalls: 0,
    sidechainRecords: 0,
    sidechainLinked: 0,
    compactions: 0,
    parseErrors: 0,
    failures: [],
    slowest: [],
  };
}

function addToAggregate(
  agg: FullAggregate,
  head: PortableSessionHead,
  stats: FullParseStats,
  messages: { isMeta?: boolean; parts: { type: string }[] }[]
): void {
  agg.files++;
  agg.bytes += stats.bytes;
  agg.parseMs += stats.parseMs;
  agg.messages += messages.length;
  agg.metaMessages += messages.filter((m) => m.isMeta).length;
  for (const message of messages)
    for (const part of message.parts) agg.parts[part.type] = (agg.parts[part.type] ?? 0) + 1;
  mergeHistogram(agg.toolNames, stats.toolNames);
  mergeHistogram(agg.skippedRecordTypes, stats.skippedRecordTypes);
  agg.unmatchedToolResults += stats.unmatchedToolResults;
  agg.orphanToolCalls += stats.orphanToolCalls;
  agg.sidechainRecords += stats.sidechainRecords;
  agg.sidechainLinked += stats.sidechainLinked;
  agg.compactions += stats.compactions;
  agg.parseErrors += stats.parseErrors;
  agg.slowest.push({ file: head.sourceFilePath, ms: stats.parseMs, bytes: stats.bytes });
  agg.slowest.sort((a, b) => b.ms - a.ms);
  agg.slowest = agg.slowest.slice(0, 5);
}

function printAggregate(label: string, agg: FullAggregate): void {
  console.log(`\n  [full-parse] ${label}`);
  console.log(
    `    files=${agg.files} bytes=${fmtBytes(agg.bytes)} totalParse=${(agg.parseMs / 1000).toFixed(1)}s (${fmtBytes(agg.parseMs > 0 ? (agg.bytes / agg.parseMs) * 1000 : 0)}/s)`
  );
  console.log(
    `    messages=${agg.messages} (meta=${agg.metaMessages}) parts=${JSON.stringify(agg.parts)}`
  );
  console.log(
    `    toolResults: unmatched=${agg.unmatchedToolResults} orphanCalls=${agg.orphanToolCalls} | sidechain: records=${agg.sidechainRecords} linked=${agg.sidechainLinked} | compactions=${agg.compactions} | jsonErrors=${agg.parseErrors}`
  );
  console.log(
    `    top tools: ${topEntries(agg.toolNames, 12)
      .map(([k, v]) => `${k}×${v}`)
      .join(", ")}`
  );
  console.log(
    `    skipped record types: ${topEntries(agg.skippedRecordTypes, 14)
      .map(([k, v]) => `${k}×${v}`)
      .join(", ")}`
  );
  if (agg.failures.length) {
    console.log(`    FAILURES (${agg.failures.length}):`);
    for (const f of agg.failures.slice(0, 5)) console.log(`      ${f.file}: ${f.error}`);
  }
  console.log(
    `    slowest: ${agg.slowest.map((s) => `${s.file.split("/").at(-1)} ${s.ms.toFixed(0)}ms/${fmtBytes(s.bytes)}`).join("; ")}`
  );
}

// ---------------------------------------------------------------------------
// 1. Claude Code
// ---------------------------------------------------------------------------

async function probeClaude(): Promise<void> {
  console.log("\n═══ CLAUDE CODE ═══");
  const t0 = performance.now();
  const heads = await claudeCode.scan({ homeDir: HOME });
  const scanMs = performance.now() - t0;

  const withCwd = heads.filter((h) => h.identity.cwd !== "");
  const totalBytes = heads.reduce((a, h) => a + h.sourceSizeBytes, 0);
  console.log(
    `  scan: ${heads.length} sessions, ${fmtBytes(totalBytes)}, headParse=${(scanMs / 1000).toFixed(1)}s`
  );
  console.log(
    `  cwd extracted: ${withCwd.length}/${heads.length}; truncatedHeads=${heads.filter((h) => h.truncatedHead).length}; withTitle=${heads.filter((h) => h.title).length}; withPrompt=${heads.filter((h) => h.firstUserPrompt).length}`
  );

  // Cursor's slug-derivation bug: how many sessions would replaceAll("/", "-") miss?
  const slugMismatches = new Set<string>();
  for (const head of withCwd) {
    const actualDir = head.sourceFilePath.split("/").at(-2)!;
    const naive = head.identity.cwd.replaceAll("/", "-");
    if (naive !== actualDir) slugMismatches.add(`${head.identity.cwd} → ${actualDir}`);
  }
  console.log(
    `  slug-derivation mismatches (Cursor's replaceAll('/','-') would MISS these dirs): ${slugMismatches.size}`
  );
  for (const m of [...slugMismatches].slice(0, 6)) console.log(`    ${m}`);

  const headUnhandled: Record<string, number> = {};
  for (const head of heads)
    for (const t of head.unhandledTypes) headUnhandled[t] = (headUnhandled[t] ?? 0) + 1;
  console.log(`  head-parse unhandled record types: ${JSON.stringify(headUnhandled)}`);

  report.claude = {
    sessions: heads.length,
    totalBytes,
    scanMs,
    cwdExtracted: withCwd.length,
    slugMismatches: [...slugMismatches],
    headUnhandled,
  };
  if (headsOnly) return;

  const agg = newAggregate();
  for (const head of heads) {
    try {
      const session = await claudeCode.fullParse(head);
      addToAggregate(agg, head, session.stats, session.messages);
    } catch (error) {
      agg.failures.push({ file: head.sourceFilePath, error: String(error) });
    }
  }
  printAggregate("all sessions", agg);
  report.claudeFull = agg;

  // Self-test: reconstruct the newest session in THIS worktree's cwd.
  const own = heads.find((h) => h.identity.cwd.includes("buenos-aires"));
  if (own) {
    const session = await claudeCode.fullParse(own);
    const visible = session.messages.filter((m) => !m.isMeta);
    console.log(
      `\n  [self-test] ${own.sourceFilePath.split("/").at(-1)} (${fmtBytes(own.sourceSizeBytes)})`
    );
    console.log(
      `    title="${truncate(own.title ?? own.firstUserPrompt, 60)}" messages=${session.messages.length} visible=${visible.length}`
    );
    for (const m of visible.slice(0, 3))
      console.log(
        `    ${m.role}: ${truncate(m.text ?? m.parts.map((p) => (p.type === "TEXT" ? p.text : `[${p.type}]`)).join(" "), 90)}`
      );
  }
}

// ---------------------------------------------------------------------------
// 2. Codex
// ---------------------------------------------------------------------------

async function probeCodex(): Promise<void> {
  console.log("\n═══ CODEX ═══");
  const t0 = performance.now();
  const heads = await codex.scan({ homeDir: HOME });
  const scanMs = performance.now() - t0;

  const totalBytes = heads.reduce((a, h) => a + h.sourceSizeBytes, 0);
  const withCwd = heads.filter((h) => h.identity.cwd !== "");
  console.log(
    `  scan: ${heads.length} rollouts, ${fmtBytes(totalBytes)}, headParse=${(scanMs / 1000).toFixed(1)}s`
  );
  console.log(
    `  cwd extracted: ${withCwd.length}/${heads.length}; withPrompt=${heads.filter((h) => h.firstUserPrompt).length}; truncatedHeads=${heads.filter((h) => h.truncatedHead).length}`
  );

  // Who produced these sessions? (originator/source captured by head-parse)
  const originators: Record<string, number> = {};
  for (const head of heads) {
    const key = head.extra ? `${head.extra.originator}/${head.extra.source}` : "missing";
    originators[key] = (originators[key] ?? 0) + 1;
  }
  console.log(`  originator/source: ${JSON.stringify(originators)}`);

  report.codex = {
    sessions: heads.length,
    totalBytes,
    scanMs,
    cwdExtracted: withCwd.length,
    originators,
  };
  if (headsOnly) return;

  const agg = newAggregate();
  for (const head of heads) {
    try {
      const session = await codex.fullParse(head);
      addToAggregate(agg, head, session.stats, session.messages);
    } catch (error) {
      agg.failures.push({ file: head.sourceFilePath, error: String(error) });
    }
  }
  printAggregate("all rollouts", agg);
  report.codexFull = agg;
}

// ---------------------------------------------------------------------------
// 3. Cursor
// ---------------------------------------------------------------------------

async function probeCursor(): Promise<void> {
  console.log("\n═══ CURSOR ═══");
  const src = join(HOME, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  const dbPath = "/tmp/agent-ports-cursor-state.vscdb";
  try {
    await fsp.copyFile(src, dbPath);
    await fsp.copyFile(`${src}-wal`, `${dbPath}-wal`).catch(() => {});
  } catch (error) {
    console.log(`  cannot copy state.vscdb: ${String(error)}`);
    return;
  }
  const stat = await fsp.stat(dbPath);
  console.log(`  db copy: ${fmtBytes(stat.size)}`);
  console.log(`  key prefixes: ${JSON.stringify(await cursor.keyPrefixHistogram(dbPath))}`);

  const t0 = performance.now();
  const heads = await cursor.scan({
    dbPath,
    workspaceStorageDir: join(HOME, "Library/Application Support/Cursor/User/workspaceStorage"),
  });
  const scanMs = performance.now() - t0;

  const eras: Record<string, number> = {};
  const versions: Record<string, number> = {};
  for (const head of heads) {
    eras[head.era] = (eras[head.era] ?? 0) + 1;
    versions[String(head.composerVersion ?? "?")] =
      (versions[String(head.composerVersion ?? "?")] ?? 0) + 1;
  }
  const withCwd = heads.filter((h) => h.identity.cwd !== "");
  console.log(`  scan: ${heads.length} composers in ${(scanMs / 1000).toFixed(1)}s`);
  console.log(`  eras: ${JSON.stringify(eras)}  versions(_v): ${JSON.stringify(versions)}`);
  console.log(
    `  cwd mapped via workspaceStorage: ${withCwd.length}/${heads.length}; withTitle=${heads.filter((h) => h.title).length}`
  );

  report.cursor = { composers: heads.length, eras, versions, cwdMapped: withCwd.length, scanMs };
  if (headsOnly) return;

  const agg = newAggregate();
  const readable = heads.filter(
    (h) => h.era === "inline" || h.era === "bubbles" || h.era === "blob"
  );
  for (const head of readable) {
    try {
      const session = await cursor.fullParse(head);
      addToAggregate(agg, head, session.stats, session.messages);
    } catch (error) {
      agg.failures.push({ file: `composer:${head.identity.sessionId}`, error: String(error) });
    }
  }
  printAggregate(`readable composers (${readable.length}/${heads.length})`, agg);
  report.cursorFull = agg;

  // Show one reconstructed blob-era conversation as evidence (highest fidelity).
  const sample =
    readable.filter((h) => h.era === "blob").sort((a, b) => b.messageCount - a.messageCount)[0] ??
    readable.find((h) => h.bubbleCount > 4);
  if (sample) {
    const session = await cursor.fullParse(sample);
    const visible = session.messages.filter((m) => !m.isMeta);
    console.log(
      `\n  [sample] "${truncate(sample.title ?? sample.firstUserPrompt, 50)}" era=${sample.era} _v=${sample.composerVersion} refs=${sample.messageCount} → ${session.messages.length} messages (${visible.length} visible)`
    );
    for (const m of visible.slice(0, 5))
      console.log(
        `    ${m.role}: ${truncate(m.parts.map((p) => (p.type === "TEXT" ? p.text : `[${p.type}${p.type === "TOOL" ? `:${p.toolName}` : ""}]`)).join(" "), 90)}`
      );
  }
}

// ---------------------------------------------------------------------------

const t0 = performance.now();
await probeClaude();
await probeCodex();
await probeCursor();
console.log(`\nTOTAL PROBE TIME: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

await fsp.writeFile("/tmp/agent-ports-report.json", JSON.stringify(report, null, 2));
console.log("report JSON → /tmp/agent-ports-report.json");
