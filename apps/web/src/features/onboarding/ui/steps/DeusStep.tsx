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

interface DeusStepProps {
  onBack: () => void;
  onComplete: () => void;
}

const REPO = {
  url: "https://github.com/zvadaadam/deus",
  name: "deus",
  displayName: "Deus",
  displayUrl: "github.com/zvadaadam/deus",
  description: "The source behind the tool you\u2019re using right now.",
} as const;

/**
 * Detects whether a git_clone error means the repo already exists on disk.
 *
 * git_clone returns several variants depending on the code path:
 *   - "already contains a git repository" -- .git dir found in target (pre-clone check)
 *   - "already exists and is not empty" -- non-empty target dir without .git
 *   - "already exists" -- git CLI stderr when target dir exists
 *   - "destination path ... already exists" -- another git CLI stderr variant
 */
function isAlreadyClonedError(message: string): boolean {
  return (
    message.includes("already contains") ||
    message.includes("already exists") ||
    message.includes("destination path")
  );
}

/**
 * Fire-and-forget: clone repo, register in DB, invalidate queries.
 *
 * Runs independently of React component lifecycle -- safe to call then unmount.
 * Uses only singletons: invoke, RepoService, queryClient, toast.
 * On success the repo appears in the sidebar via query invalidation.
 * On failure a toast tells the user what happened (the <Toaster> mounts
 * in App.tsx after onboarding completes, well before this async work finishes).
 */
async function cloneAndRegisterInBackground() {
  try {
    const home = await native.dialog.getHomeDir();
    const target = `${home}/Developer/${REPO.name}`;

    // Phase 1: Clone (or detect already-cloned)
    let alreadyCloned = false;
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
      if (!isAlreadyClonedError(message)) {
        console.error("[Deus] Clone failed:", message);
        toast.error("Couldn\u2019t clone Deus. You can add it later from the sidebar.");
        return;
      }
      alreadyCloned = true;
    }

    // Phase 2: Register in DB (idempotent -- 409 = already registered)
    let repoId: string | null = null;
    try {
      const repo = await RepoService.add(target);
      repoId = repo.id;
    } catch (err) {
      // ApiError shape from client.ts: { status, message, details: <response body> }
      // 409 response body: { error: "...", details: { id, name, ... } }
      const apiErr = err as { status?: number; details?: { details?: unknown } };
      if (apiErr?.status === 409) {
        const existing = apiErr.details?.details;
        if (existing && typeof existing === "object" && "id" in existing) {
          repoId = (existing as { id: string }).id;
        }
        if (!repoId) {
          console.warn("[Deus] 409 conflict but couldn't extract repo ID:", err);
        }
      } else {
        console.error("[Deus] Register failed:", err);
        toast.error('Deus cloned but couldn\u2019t register. Use "Add Repository" in the sidebar.');
        return;
      }
    }

    // Phase 3: Create workspace so repo appears in the sidebar.
    // The sidebar only shows repos that have at least one workspace.
    if (repoId) {
      try {
        await WorkspaceService.create(repoId);
      } catch {
        // Workspace creation failed -- repo is registered, user can create manually.
        // Don't block the success toast; the repo exists and can be used.
        console.warn("[Deus] Workspace creation failed, repo still registered");
      }
    }

    // Phase 4: Refresh sidebar so the new repo + workspace appear
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
    // Launch background pipeline -- intentionally not awaited.
    // Uses zero React state; completes independently of component lifecycle.
    cloneAndRegisterInBackground();

    // Complete onboarding immediately. If this fails (unlikely -- it's
    // just a settings write), TanStack Query's built-in retry handles it.
    await completeMutation.mutateAsync();
    onComplete();
  }, [completeMutation, onComplete]);

  const handleSkip = useCallback(async () => {
    await completeMutation.mutateAsync();
    onComplete();
  }, [completeMutation, onComplete]);

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      {/* Badge */}
      <span className="text-2xs font-medium tracking-wider text-white/30 uppercase">
        Community Built
      </span>

      {/* Header */}
      <div className="-mt-4 space-y-2">
        <h2 className="text-2xl font-semibold text-white">Shape Deus with us</h2>
        <p className="text-sm text-white/50">
          Deus is built by the people who use it. Clone the source, send a PR, or share an idea. You
          have the power to shape it.
        </p>
      </div>

      {/* Repo card */}
      <div className="flex items-center gap-3 rounded-xl bg-white/[0.04] p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.08]">
          <Github className="h-4.5 w-4.5 text-white/40" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{REPO.displayName}</p>
          <p className="truncate font-mono text-xs text-white/30">{REPO.displayUrl}</p>
        </div>
      </div>

      {/* Description line */}
      <p className="text-xs text-white/40 italic">{REPO.description}</p>

      <div className="min-h-[28px]" />

      {/* Footer */}
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
