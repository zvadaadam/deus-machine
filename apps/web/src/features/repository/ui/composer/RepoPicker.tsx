/**
 * The Home composer's project picker: the trigger that names the chosen
 * project, and the list behind it (filter, projects, and the three ways to add
 * one). One list, two shells: a dropdown under the trigger on desktop, a bottom
 * sheet with roomier rows on a phone.
 */
import { tempo } from "@/shared/lib/tempo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, FolderGit2, FolderOpen, GitBranch, Search } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { githubRepoSlug } from "@shared/git-origin";
import { match } from "ts-pattern";
import { capabilities } from "@/platform/capabilities";
import { GitHubIcon } from "@/shared/components/icons/GitHubIcon";
import { addProjectActions, type AddProjectAction } from "../../lib/addProject";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { cn } from "@/shared/lib/utils";
import type { Repository } from "../../types";

interface RepoPickerProps {
  repos: Repository[];
  selectedRepo: Repository | null;
  onSelect: (repoId: string) => void;
  /** The ways to add a project, by the composer's place; this computer's when not given. */
  addActions?: AddProjectAction[];
  onOpenProject?: () => void;
  onCloneRepository?: () => void;
  onStartNewProject?: () => void;
  onAddFromGitHub?: () => void;
}

function abbreviatePath(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/)?.[0];
  if (home) return path.replace(home, "~");
  return path;
}

/** Where a project lives: its folder, or `owner/name` for one not on this computer. */
function repoLocation(repo: Repository): string {
  if (repo.root_path) return abbreviatePath(repo.root_path);
  const origin = repo.git_origin_url ?? "";
  return githubRepoSlug(origin) ?? origin;
}

export function RepoPicker({
  repos,
  selectedRepo,
  onSelect,
  onOpenProject,
  onCloneRepository,
  onStartNewProject,
  onAddFromGitHub,
  addActions,
}: RepoPickerProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setFilter("");
  }, []);

  // Close on outside click (desktop only — Sheet handles its own dismissal on mobile)
  useEffect(() => {
    if (isMobile || !open) return;
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isMobile, open, close]);

  const list = (
    <RepoList
      roomy={isMobile}
      repos={repos}
      selectedRepoId={selectedRepo?.id ?? null}
      filter={filter}
      onFilterChange={setFilter}
      onSelect={(repoId) => {
        close();
        onSelect(repoId);
      }}
      actions={(
        addActions ??
        addProjectActions("local", { nativeFolderPicker: capabilities.nativeFolderPicker })
      )
        .map((action) =>
          match(action)
            .with("start-new", () => ({
              icon: FolderGit2,
              label: "Start new project",
              run: onStartNewProject,
            }))
            .with("clone", () => ({
              icon: GitBranch,
              label: "Clone from GitHub",
              run: onCloneRepository,
            }))
            .with("open-local", () => ({
              icon: FolderOpen,
              label: "Open local...",
              run: onOpenProject,
            }))
            .with("add-from-github", () => ({
              icon: GitHubIcon as typeof FolderOpen,
              label: "Add from GitHub",
              run: onAddFromGitHub,
            }))
            .exhaustive()
        )
        .flatMap(({ run, ...action }) => (run ? [{ ...action, run: () => (close(), run()) }] : []))}
    />
  );

  return (
    <div ref={pickerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="control-interaction text-text-muted hover:text-text-secondary group flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm"
      >
        {/* Green glow dot — active project indicator */}
        <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
          <span className="bg-accent-green/30 absolute -inset-0.5 rounded-full blur-[2px]" />
          <span className="bg-accent-green relative h-1.5 w-1.5 rounded-full" />
        </span>
        <span className="max-w-[200px] truncate font-medium">
          {/* Nothing here can run where the composer points: its way to add one. */}
          {selectedRepo?.name ?? (repos.length === 0 ? "Add a project" : "Select repo")}
        </span>
        <ChevronDown
          className={cn("text-text-disabled size-3 transition-transform", open && "rotate-180")}
        />
      </button>

      {isMobile ? (
        <Sheet
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setFilter("");
          }}
        >
          <SheetContent side="bottom" className="rounded-t-xl px-0">
            <SheetHeader className="px-4 pb-0">
              <SheetTitle className="text-sm">Select repository</SheetTitle>
              <SheetDescription className="sr-only">
                Choose a repository for your workspace
              </SheetDescription>
            </SheetHeader>
            {list}
          </SheetContent>
        </Sheet>
      ) : (
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -4, transition: tempo.moderate.exit }}
              transition={tempo.moderate}
              className={cn(
                "absolute top-full left-0 z-50 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border",
                "border-border/55 from-bg-overlay/95 to-bg-elevated/94 bg-linear-to-b backdrop-blur-2xl",
                "shadow-[var(--shadow-elevated)]"
              )}
            >
              {list}
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}

interface RepoListProps {
  /** Phone-sized rows and type (the sheet); compact otherwise (the dropdown). */
  roomy: boolean;
  repos: Repository[];
  selectedRepoId: string | null;
  filter: string;
  onFilterChange: (filter: string) => void;
  onSelect: (repoId: string) => void;
  actions: { icon: typeof FolderOpen; label: string; run: () => void }[];
}

function RepoList({
  roomy,
  repos,
  selectedRepoId,
  filter,
  onFilterChange,
  onSelect,
  actions,
}: RepoListProps) {
  const shown = useMemo(() => {
    if (!filter) return repos;
    const query = filter.toLowerCase();
    return repos.filter((repo) => repo.name.toLowerCase().includes(query));
  }, [repos, filter]);
  const text = roomy ? "text-sm" : "text-xs";
  const row = roomy ? "py-2.5" : "py-1.5";

  return (
    <>
      <div className="border-border-subtle flex items-center gap-2 border-b px-3 py-2">
        <Search className="text-text-disabled size-3.5 shrink-0" />
        <input
          type="text"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Search repos..."
          className={cn(
            "text-text-primary placeholder:text-text-disabled w-full bg-transparent outline-none",
            text
          )}
        />
      </div>

      <div className={cn("overflow-y-auto py-1", roomy ? "max-h-[50vh]" : "max-h-[224px]")}>
        {shown.length === 0 && (
          <div className={cn("text-text-disabled px-3 py-3 text-center", text)}>No repos match</div>
        )}
        {shown.map((repo) => {
          const isSelected = repo.id === selectedRepoId;
          return (
            <button
              key={repo.id}
              type="button"
              onClick={() => onSelect(repo.id)}
              className={cn(
                "flex w-full items-center justify-between px-3 text-left transition-colors",
                "hover:bg-bg-raised/45",
                row,
                text,
                isSelected ? "text-text-primary" : "text-text-secondary"
              )}
            >
              <div className="flex items-center gap-2 overflow-hidden">
                {isSelected ? (
                  <span
                    className={cn("relative flex shrink-0", roomy ? "h-1.5 w-1.5" : "h-1 w-1")}
                    aria-hidden
                  >
                    <span className="bg-accent-green/25 absolute -inset-px rounded-full blur-[1.5px]" />
                    <span
                      className={cn(
                        "bg-accent-green relative rounded-full",
                        roomy ? "h-1.5 w-1.5" : "h-1 w-1"
                      )}
                    />
                  </span>
                ) : (
                  <span className="h-1.5 w-1.5 shrink-0" />
                )}
                <span className="truncate font-medium">{repo.name}</span>
              </div>
              <div className="flex items-center gap-2">
                {/* Where it lives, when there is room to say. */}
                {!roomy && (
                  <span className="text-text-disabled text-2xs max-w-[120px] truncate">
                    {repoLocation(repo)}
                  </span>
                )}
                {isSelected && (
                  <Check
                    className={cn("text-text-primary shrink-0", roomy ? "size-3.5" : "size-3")}
                  />
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="border-border-subtle border-t py-1">
        {actions.map(({ icon: Icon, label, run }) => (
          <button
            key={label}
            type="button"
            onClick={run}
            className={cn(
              "text-text-muted hover:text-text-secondary hover:bg-bg-raised/45 flex w-full items-center gap-2 px-3 transition-colors",
              row,
              text
            )}
          >
            <Icon className={cn("shrink-0", roomy ? "size-4" : "size-3")} />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
