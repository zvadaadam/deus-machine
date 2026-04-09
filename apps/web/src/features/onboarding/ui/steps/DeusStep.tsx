import { useCallback } from "react";
import { toast } from "sonner";
import { Github, Loader2 } from "lucide-react";
import { native } from "@/platform";
import { getBackendUrl } from "@/shared/config/api.config";
import { getErrorMessage } from "@shared/lib/errors";
import { RepoService } from "@/features/repository/api/repository.service";
import { WorkspaceService } from "@/features/workspace/api/workspace.service";
import { queryClient } from "@/shared/api/queryClient";
import { queryKeys } from "@/shared/api/queryKeys";
import { useCompleteOnboarding } from "../../api";
import { classifyCloneConflict, isMatchingGitHubRepo } from "../../lib/deus-import";

interface DeusStepProps {
  onBack: () => void;
  onComplete: () => void;
}

interface InspectedRepository {
  root_path: string;
  name: string;
  git_default_branch: string;
  git_origin_url?: string | null;
}

const REPO = {
  url: "https://github.com/zvadaadam/deus",
  name: "deus",
  displayName: "Deus",
  displayUrl: "github.com/zvadaadam/deus",
  description: "The source behind the tool you’re using right now.",
} as const;

function getNonGitTargetMessage(targetPath: string): string {
  return `${targetPath} already exists, but it isn't a git repository. Remove it or add the repo manually.`;
}

function getUnexpectedRepoMessage(targetPath: string): string {
  return `${targetPath} already contains a different repository. Remove it or add Deus manually from the sidebar.`;
}

async function inspectRepository(rootPath: string): Promise<InspectedRepository> {
  const baseUrl = await getBackendUrl();
  const res = await fetch(`${baseUrl}/api/repos/inspect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root_path: rootPath }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Inspect failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return (await res.json()) as InspectedRepository;
}

async function resolveExistingRepoId(targetPath: string): Promise<string | null> {
  try {
    const repos = await RepoService.fetchAll();
    return repos.find((repo) => repo.root_path === targetPath)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget: clone repo, register in DB, invalidate queries.
 *
 * Runs independently of React component lifecycle -- safe to call then unmount.
 * Uses only singletons: RepoService, queryClient, toast.
 * On success the repo appears in the sidebar via query invalidation.
 * On failure a toast tells the user what happened (the <Toaster> mounts
 * in App.tsx after onboarding completes, well before this async work finishes).
 */
async function cloneAndRegisterInBackground() {
  try {
    const home = await native.dialog.getHomeDir();
    const target = `${home}/Developer/${REPO.name}`;

    let alreadyCloned = false;
    let repoRoot = target;

    try {
      const baseUrl = await getBackendUrl();
      const res = await fetch(`${baseUrl}/api/repos/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: REPO.url, targetPath: target }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Clone failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      const message = getErrorMessage(err);
      const conflictKind = classifyCloneConflict(message);

      if (conflictKind === "already_cloned") {
        try {
          const inspectedRepo = await inspectRepository(target);
          if (!isMatchingGitHubRepo(inspectedRepo.git_origin_url, REPO.url)) {
            toast.error(getUnexpectedRepoMessage(target));
            return;
          }
          repoRoot = inspectedRepo.root_path;
          alreadyCloned = true;
        } catch (inspectError) {
          console.error("[Deus] Inspect failed:", inspectError);
          toast.error("Deus is already there, but we couldn’t verify the repository.");
          return;
        }
      } else if (conflictKind === "non_git_target") {
        toast.error(getNonGitTargetMessage(target));
        return;
      } else {
        console.error("[Deus] Clone failed:", message);
        toast.error("Couldn’t clone Deus. You can add it later from the sidebar.");
        return;
      }
    }

    let repoId: string | null = null;
    try {
      const repo = await RepoService.add(repoRoot);
      repoId = repo.id;
    } catch (err) {
      const message = getErrorMessage(err);
      const conflictKind = classifyCloneConflict(message);

      if (conflictKind === "non_git_target") {
        toast.error(getNonGitTargetMessage(repoRoot));
        return;
      }

      if (conflictKind === "already_cloned") {
        repoId = await resolveExistingRepoId(repoRoot);
        if (!repoId) {
          console.warn("[Deus] Repo already existed but no matching repo ID was found:", repoRoot);
        }
      } else {
        console.error("[Deus] Register failed:", err);
        toast.error('Deus cloned but couldn’t register. Use "Add Repository" in the sidebar.');
        return;
      }
    }

    if (repoId) {
      try {
        await WorkspaceService.create(repoId);
      } catch {
        console.warn("[Deus] Workspace creation failed, repo still registered");
      }
    }

    queryClient.invalidateQueries({ queryKey: queryKeys.repos.all });
    queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });

    toast.success(alreadyCloned ? "Deus repository added" : "Deus cloned and ready");
  } catch (err) {
    console.error("[Deus] Background clone error:", err);
    toast.error("Something went wrong cloning Deus.");
  }
}

export function DeusStep({ onBack, onComplete }: DeusStepProps) {
  const completeMutation = useCompleteOnboarding();

  /**
   * Fire-and-forget: kick off clone pipeline as a detached promise,
   * then immediately complete onboarding. The user lands in the app
   * and the repo appears in the sidebar once cloneAndRegisterInBackground
   * finishes and invalidates the query cache.
   */
  const handleCloneAndFinish = useCallback(async () => {
    void cloneAndRegisterInBackground();
    await completeMutation.mutateAsync();
    onComplete();
  }, [completeMutation, onComplete]);

  const handleSkip = useCallback(async () => {
    await completeMutation.mutateAsync();
    onComplete();
  }, [completeMutation, onComplete]);

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <span className="text-2xs font-medium tracking-wider text-white/30 uppercase">
        Community Built
      </span>

      <div className="-mt-4 space-y-2">
        <h2 className="text-2xl font-semibold text-white">Shape Deus with us</h2>
        <p className="text-sm text-white/50">
          Deus is built by the people who use it. Clone the source, send a PR, or share an idea. You
          have the power to shape it.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-xl bg-white/[0.04] p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.08]">
          <Github className="h-4.5 w-4.5 text-white/40" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{REPO.displayName}</p>
          <p className="truncate font-mono text-xs text-white/30">{REPO.displayUrl}</p>
        </div>
      </div>

      <p className="text-xs text-white/40 italic">{REPO.description}</p>

      <div className="min-h-[28px]" />

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={onBack}
          disabled={completeMutation.isPending}
          className="rounded-xl px-6 py-2.5 text-sm font-medium text-white/50 transition-colors duration-200 hover:text-white/80 disabled:opacity-50"
        >
          Back
        </button>
        <div className="flex-1" />

        <button
          onClick={handleSkip}
          disabled={completeMutation.isPending}
          className="rounded-xl bg-white/10 px-6 py-2.5 text-sm font-medium text-white/70 transition-colors duration-200 hover:bg-white/15 hover:text-white disabled:opacity-50"
        >
          Skip
        </button>

        <button
          onClick={handleCloneAndFinish}
          disabled={completeMutation.isPending}
          className="rounded-xl bg-white px-6 py-2.5 text-sm font-semibold text-black transition-transform duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
        >
          {completeMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Clone & Continue"
          )}
        </button>
      </div>
    </div>
  );
}
