import { useState, useCallback } from "react";
import { toast } from "sonner";
import { Loader2, FolderOpen } from "lucide-react";
import { getErrorMessage } from "@shared/lib/errors";
import { useRecentProjects } from "../../api";
import { useAddRepo } from "@/features/repository/api";
import { native } from "@/platform";
import { capabilities } from "@/platform/capabilities";
import { ProjectCard } from "../components/ProjectCard";
import { classifyCloneConflict } from "../../lib/deus-import";

interface ProjectSelectionStepProps {
  onBack: () => void;
  onNext: () => void;
}

export function ProjectSelectionStep({ onBack, onNext }: ProjectSelectionStepProps) {
  const projectsQuery = useRecentProjects();
  const addRepoMutation = useAddRepo();
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const projects = projectsQuery.data?.projects ?? [];

  const toggleProject = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  async function handleOpenProjects() {
    if (selectedPaths.size === 0) return;
    setImporting(true);
    try {
      const results = await Promise.allSettled(
        [...selectedPaths].map((projectPath) => addRepoMutation.mutateAsync(projectPath))
      );

      let added = 0;
      let alreadyPresent = 0;
      let failed = 0;

      for (const result of results) {
        if (result.status === "fulfilled") {
          added += 1;
          continue;
        }

        const conflictKind = classifyCloneConflict(getErrorMessage(result.reason));
        if (conflictKind === "already_cloned") {
          alreadyPresent += 1;
        } else {
          failed += 1;
        }
      }

      const succeeded = added + alreadyPresent;
      if (succeeded === 0) {
        toast.error("Couldn’t add any of the selected projects.");
        return;
      }

      if (failed > 0) {
        const parts: string[] = [];
        if (added > 0) {
          parts.push(`Added ${added} project${added > 1 ? "s" : ""}`);
        }
        if (alreadyPresent > 0) {
          parts.push(`${alreadyPresent} already in Deus`);
        }
        toast.error(`${parts.join(", ")}, but ${failed} failed.`);
      }

      onNext();
    } finally {
      setImporting(false);
    }
  }

  async function handleBrowse() {
    try {
      const folderPath = await native.dialog.pickFolder();
      if (!folderPath) return;
      setImporting(true);
      await addRepoMutation.mutateAsync(folderPath);
      onNext();
    } catch (error) {
      const message = getErrorMessage(error);
      const conflictKind = classifyCloneConflict(message);

      console.error("[Onboarding] Browse/add repo failed:", error);

      if (conflictKind === "already_cloned") {
        toast.success("That project is already in Deus.");
        onNext();
        return;
      }

      if (conflictKind === "non_git_target") {
        toast.error("Couldn’t add that folder. Make sure it’s a git repository.");
        return;
      }

      toast.error(`Couldn’t add that folder: ${message}`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex w-full max-w-lg flex-col gap-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold text-white">Your Projects</h2>
        <p className="text-sm text-white/50">
          Select projects to add to Deus, or browse for a folder.
        </p>
      </div>

      {projectsQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-white/30" />
        </div>
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <FolderOpen className="h-8 w-8 text-white/20" />
          <p className="text-sm text-white/40">No recent projects found. Browse to add one.</p>
        </div>
      ) : (
        <div className="max-h-[340px] space-y-2 overflow-y-auto pr-1">
          {projects.map((project) => (
            <ProjectCard
              key={`${project.source}:${project.path}`}
              project={project}
              selected={selectedPaths.has(project.path)}
              onToggle={() => toggleProject(project.path)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <button
          onClick={onBack}
          disabled={importing}
          className="rounded-xl px-4 py-2 text-sm text-white/50 transition-colors hover:text-white disabled:opacity-50"
        >
          Back
        </button>

        <div className="ml-auto flex items-center gap-3">
          {capabilities.nativeFolderPicker && (
            <button
              onClick={handleBrowse}
              disabled={importing}
              className="rounded-xl border border-white/10 px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/5 disabled:opacity-50"
            >
              Browse Folder
            </button>
          )}

          <button
            onClick={handleOpenProjects}
            disabled={importing || selectedPaths.size === 0}
            className="rounded-xl bg-white px-5 py-2 text-sm font-semibold text-black transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
