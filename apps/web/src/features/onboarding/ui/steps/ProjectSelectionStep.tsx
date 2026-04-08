import { useState, useCallback } from "react";
import { toast } from "sonner";
import { Loader2, FolderOpen } from "lucide-react";
import { useRecentProjects } from "../../api";
import { useAddRepo } from "@/features/repository/api";
import { native } from "@/platform";
import { capabilities } from "@/platform/capabilities";
import { ProjectCard } from "../components/ProjectCard";

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
      const succeeded = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - succeeded;

      if (succeeded === 0) {
        toast.error("Couldn’t add any of the selected projects.");
        return;
      }

      if (failed > 0) {
        toast.error(`Added ${succeeded} project${succeeded > 1 ? "s" : ""}, but ${failed} failed.`);
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
    } catch {
      toast.error("Couldn’t add that folder. Make sure it’s a git repository.");
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
        <div
          className="flex max-h-[320px] flex-col gap-2 overflow-y-auto pr-1"
          style={{
            maskImage:
              "linear-gradient(to bottom, transparent, black 24px, black calc(100% - 32px), transparent)",
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent, black 24px, black calc(100% - 32px), transparent)",
          }}
        >
          {projects.map((project) => (
            <ProjectCard
              key={project.path}
              project={project}
              selected={selectedPaths.has(project.path)}
              onToggle={toggleProject}
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={onBack}
          className="rounded-xl px-6 py-2.5 text-sm font-medium text-white/50 transition-colors duration-200 hover:text-white/80"
        >
          Back
        </button>
        <div className="flex-1" />
        <button
          onClick={onNext}
          className="rounded-xl bg-white/10 px-6 py-2.5 text-sm font-medium text-white/70 transition-colors duration-200 hover:bg-white/15 hover:text-white"
        >
          Skip
        </button>
        {capabilities.nativeFolderPicker && (
          <button
            onClick={handleBrowse}
            disabled={importing}
            className="rounded-xl bg-white/10 px-6 py-2.5 text-sm font-medium text-white/70 transition-colors duration-200 hover:bg-white/15 hover:text-white disabled:opacity-50"
          >
            Browse...
          </button>
        )}
        {selectedPaths.size > 0 && (
          <button
            onClick={handleOpenProjects}
            disabled={importing}
            className="rounded-xl bg-white px-6 py-2.5 text-sm font-semibold text-black transition-transform duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
          >
            {importing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              `Open ${selectedPaths.size} Project${selectedPaths.size > 1 ? "s" : ""}`
            )}
          </button>
        )}
      </div>
    </div>
  );
}
