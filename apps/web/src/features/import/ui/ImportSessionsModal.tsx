// features/import/ui/ImportSessionsModal.tsx
// Picker for sessions found in other coding agents' local storage (Claude Code,
// Codex, Cursor), grouped by the project they were worked on. Groups are
// collapsed by default; provider chips filter the list; importing (per session,
// per group, or all) inserts the full conversation via importExternalSession.

import { createElement, useMemo, useState } from "react";
import { toast } from "sonner";
import { AnimatePresence, m } from "framer-motion";
import { ChevronRight, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getAgentLogo } from "@/assets/agents";
import { cn } from "@/shared/lib/utils";
import type {
  ImportProvider,
  ImportableGroup,
  ImportableSessionDTO,
} from "@shared/types/session-import";
import { importExternalSession, useImportableSessions } from "../api/import.queries";

const ALL_PROVIDERS: ImportProvider[] = ["claude-code", "codex", "cursor"];

const PROVIDER_LOGO_KEY: Record<ImportProvider, string> = {
  "claude-code": "claude-code",
  codex: "codex-sdk",
  cursor: "cursor",
};

const PROVIDER_LABEL: Record<ImportProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

function ProviderLogo({ provider, className }: { provider: ImportProvider; className?: string }) {
  const Logo = getAgentLogo(PROVIDER_LOGO_KEY[provider]);
  if (!Logo)
    return <span className={cn("bg-muted-foreground/80 inline-flex rounded-full", className)} />;
  return createElement(Logo, { className: cn("flex-shrink-0", className) });
}

function relativeTime(iso?: string): string {
  const ts = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ts)) return "";
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function noTargetHint(group: ImportableGroup): string {
  return group.kind === "unknown"
    ? "No matching project — add this folder as a repository first"
    : "No workspace in this project — create one first";
}

function groupKey(group: ImportableGroup): string {
  return group.repositoryId ?? `${group.projectName}:${group.sessions[0]?.cwd ?? ""}`;
}

interface ImportSessionsModalProps {
  open: boolean;
  onClose: () => void;
  /** Select the workspace a session was imported into (from MainLayout). */
  onOpenWorkspace?: (workspaceId: string, repositoryId?: string) => void;
}

export function ImportSessionsModal({ open, onClose, onOpenWorkspace }: ImportSessionsModalProps) {
  const { data: snapshot, isLoading } = useImportableSessions(open);
  const [enabledProviders, setEnabledProviders] = useState<Set<ImportProvider>>(
    () => new Set(ALL_PROVIDERS)
  );
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const busy = busyKey !== null || bulk !== null;

  const scanning = isLoading || snapshot === undefined || snapshot.status === "scanning";
  const allGroups = useMemo(() => snapshot?.groups ?? [], [snapshot]);

  // Provider chip counts reflect everything DISCOVERED (snapshot.totals),
  // not just the capped listing — so truncation is visible to the user.
  const providerCounts = useMemo(() => {
    if (snapshot?.totals) return snapshot.totals;
    const counts: Record<ImportProvider, number> = { "claude-code": 0, codex: 0, cursor: 0 };
    for (const group of allGroups) for (const session of group.sessions) counts[session.provider]++;
    return counts;
  }, [snapshot, allGroups]);

  const groups = useMemo(
    () =>
      allGroups
        .map((group) => ({
          ...group,
          sessions: group.sessions.filter((s) => enabledProviders.has(s.provider)),
        }))
        .filter((group) => group.sessions.length > 0),
    [allGroups, enabledProviders]
  );

  const pendingSessions = useMemo(
    () =>
      groups.flatMap((group) =>
        group.defaultWorkspaceId
          ? group.sessions
              .filter((s) => !s.imported)
              .map((s) => ({ session: s, workspaceId: group.defaultWorkspaceId! }))
          : []
      ),
    [groups]
  );
  const totalListed = groups.reduce((a, g) => a + g.sessions.length, 0);
  const totalImported = groups.reduce((a, g) => a + g.sessions.filter((s) => s.imported).length, 0);

  const toggleProvider = (provider: ImportProvider) => {
    setEnabledProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) {
        // Never allow zero providers — clicking the last one reselects it alone.
        if (next.size === 1) return new Set(ALL_PROVIDERS);
        next.delete(provider);
      } else {
        next.add(provider);
      }
      return next;
    });
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const importOne = async (
    session: ImportableSessionDTO,
    workspaceId: string | undefined,
    repositoryId?: string
  ) => {
    if (!workspaceId) {
      toast.error("No workspace to import into — create a workspace first");
      return;
    }
    setBusyKey(session.key);
    try {
      const ack = await importExternalSession(session.key, workspaceId);
      if (!ack.accepted) throw new Error(ack.error || "Import failed");
      toast.success(ack.alreadyImported ? "Already imported" : `Imported "${session.title}"`, {
        action:
          onOpenWorkspace && ack.workspaceId
            ? {
                label: "Open",
                onClick: () => {
                  onOpenWorkspace(ack.workspaceId!, repositoryId);
                  onClose();
                },
              }
            : undefined,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusyKey(null);
    }
  };

  const importMany = async (
    items: { session: ImportableSessionDTO; workspaceId: string }[],
    label: string
  ) => {
    if (items.length === 0) return;
    setBulk({ done: 0, total: items.length });
    let failures = 0;
    for (let i = 0; i < items.length; i++) {
      const { session, workspaceId } = items[i];
      try {
        const ack = await importExternalSession(session.key, workspaceId);
        if (!ack.accepted) failures++;
      } catch {
        failures++;
      }
      setBulk({ done: i + 1, total: items.length });
    }
    setBulk(null);
    if (failures > 0)
      toast.error(
        `Imported ${items.length - failures} of ${items.length} ${label} (${failures} failed)`
      );
    else toast.success(`Imported ${items.length} ${label}`);
  };

  const importGroup = (group: ImportableGroup) => {
    if (!group.defaultWorkspaceId) {
      toast.error("No workspace to import into — create a workspace first");
      return;
    }
    const pending = group.sessions
      .filter((s) => !s.imported)
      .map((s) => ({ session: s, workspaceId: group.defaultWorkspaceId! }));
    void importMany(pending, `sessions from ${group.projectName}`);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-[640px]"
        // Don't auto-focus the first chip on open — the ring should only show
        // for real keyboard navigation. Focus lands on the panel (outline-none).
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="border-border-subtle border-b px-6 pt-5 pb-4">
          <DialogTitle>Import agent sessions</DialogTitle>
          <DialogDescription>
            Conversations found on this Mac, grouped by the project they were worked on.
          </DialogDescription>
          {/* Provider filter chips */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {ALL_PROVIDERS.map((provider) => {
              const active = enabledProviders.has(provider);
              return (
                <button
                  key={provider}
                  type="button"
                  onClick={() => toggleProvider(provider)}
                  aria-pressed={active}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors duration-150",
                    "focus-visible:ring-primary/35 outline-none focus-visible:ring-2",
                    active
                      ? "border-border-default bg-bg-raised text-text-secondary"
                      : "border-border-subtle text-text-disabled hover:text-text-muted opacity-70"
                  )}
                >
                  <ProviderLogo
                    provider={provider}
                    className={cn("h-3.5 w-3.5", !active && "opacity-50")}
                  />
                  {PROVIDER_LABEL[provider]}
                  {!scanning && (
                    <span className="text-text-disabled tabular-nums">
                      {providerCounts[provider]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {scanning && (
            <div className="text-text-muted flex items-center justify-center gap-2 py-10 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning local agent storage…
            </div>
          )}
          {!scanning && snapshot?.status === "error" && (
            <div className="text-text-muted py-10 text-center text-sm">
              Scan failed: {snapshot.error}
            </div>
          )}
          {!scanning && snapshot?.status === "ready" && totalListed === 0 && (
            <div className="text-text-muted py-10 text-center text-sm">
              No importable sessions found in the last 6 months.
            </div>
          )}
          {!scanning &&
            groups.map((group) => {
              const key = groupKey(group);
              const expanded = expandedGroups.has(key);
              const pending = group.sessions.filter((s) => !s.imported).length;
              return (
                <div
                  key={key}
                  className="border-border-subtle bg-bg-elevated/60 mb-2 overflow-hidden rounded-xl border"
                >
                  {/* Group header — click to expand/collapse */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleGroup(key)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleGroup(key);
                      }
                    }}
                    className="hover:bg-bg-raised/40 group/import-group focus-visible:ring-primary/35 flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-3 text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset"
                  >
                    <ChevronRight
                      className={cn(
                        "text-text-muted h-3.5 w-3.5 shrink-0 transition-transform duration-150",
                        expanded && "rotate-90"
                      )}
                    />
                    <span className="text-text-primary min-w-0 truncate text-[13px] font-medium">
                      {group.projectName}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium",
                        group.kind === "unknown"
                          ? "bg-bg-muted text-text-muted"
                          : "bg-accent-green/15 text-accent-green"
                      )}
                    >
                      {group.kind === "unknown" ? "no project" : "matched"}
                    </span>
                    <span className="text-text-disabled min-w-0 flex-1 truncate text-[11px]">
                      {group.sessions[0]?.cwd.replace(/^\/Users\/[^/]+/, "~")}
                    </span>
                    <span className="text-text-muted hidden shrink-0 text-[11px] tabular-nums sm:inline">
                      {group.sessions.length} session{group.sessions.length === 1 ? "" : "s"}
                    </span>
                    {pending > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 shrink-0 px-2 text-[11px]"
                        disabled={busy || !group.defaultWorkspaceId}
                        title={group.defaultWorkspaceId ? undefined : noTargetHint(group)}
                        onClick={(e) => {
                          e.stopPropagation();
                          importGroup(group);
                        }}
                      >
                        Import {pending}
                      </Button>
                    )}
                    {pending === 0 && (
                      <span className="text-text-disabled shrink-0 text-[11px]">Imported</span>
                    )}
                  </div>

                  {/* Sessions — collapsed by default */}
                  <AnimatePresence initial={false}>
                    {expanded && (
                      <m.div
                        key="sessions"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="border-border-subtle/50 border-t">
                          {group.sessions.map((session, index) => (
                            <div key={session.key}>
                              {index > 0 && (
                                <div className="border-border-subtle/50 mx-4 border-t" />
                              )}
                              <div className="hover:bg-bg-raised/40 flex w-full items-center gap-3 px-4 py-2.5 transition-colors duration-150">
                                <div className="bg-bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
                                  <ProviderLogo
                                    provider={session.provider}
                                    className="h-3.5 w-3.5"
                                  />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="text-text-primary truncate text-[13px]">
                                    {session.title}
                                  </div>
                                  <div className="text-text-muted mt-0.5 text-[11px]">
                                    {PROVIDER_LABEL[session.provider]} · {session.messageCount}
                                    {session.approximateCount ? "+" : ""} messages ·{" "}
                                    {relativeTime(session.lastTimestamp)}
                                  </div>
                                </div>
                                <Button
                                  size="sm"
                                  variant={session.imported ? "ghost" : "outline"}
                                  className="h-7 shrink-0 px-2.5 text-xs"
                                  disabled={session.imported || busy || !group.defaultWorkspaceId}
                                  title={group.defaultWorkspaceId ? undefined : noTargetHint(group)}
                                  onClick={() =>
                                    importOne(session, group.defaultWorkspaceId, group.repositoryId)
                                  }
                                >
                                  {busyKey === session.key ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : session.imported ? (
                                    "Imported"
                                  ) : (
                                    "Import"
                                  )}
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </m.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
        </div>

        {/* Footer — bulk import */}
        {!scanning && totalListed > 0 && (
          <div className="border-border-subtle flex items-center justify-between gap-3 border-t px-6 py-3.5">
            <span className="text-text-muted text-xs tabular-nums">
              {totalListed} session{totalListed === 1 ? "" : "s"}
              {totalImported > 0 && ` · ${totalImported} imported`}
            </span>
            <Button
              size="sm"
              className="h-7 px-3 text-xs"
              disabled={busy || pendingSessions.length === 0}
              onClick={() => void importMany(pendingSessions, "sessions")}
            >
              {bulk ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Importing {bulk.done}/{bulk.total}…
                </span>
              ) : pendingSessions.length === 0 ? (
                "All imported"
              ) : (
                `Import all (${pendingSessions.length})`
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
