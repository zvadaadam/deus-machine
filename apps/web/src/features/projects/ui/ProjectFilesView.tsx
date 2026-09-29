import { useMemo } from "react";
import { ArrowLeft, FileText } from "lucide-react";
import type { ProjectDetail } from "@shared/projects";
import { Button } from "@/components/ui/button";
import { FileTree } from "@/features/file-browser/ui/components/FileTree";
import { cn } from "@/shared/lib/utils";
import { buildProjectFileTree } from "../lib/projectFileTree";
import { ProjectFilePane, type ProjectFileSelection } from "./ProjectFilePane";

export function ProjectFilesView({
  project,
  selection,
  onSelect,
}: {
  project: ProjectDetail;
  selection: ProjectFileSelection | null;
  onSelect: (file: ProjectFileSelection | null) => void;
}) {
  const nodes = useMemo(() => buildProjectFileTree(project.files), [project.files]);
  const availablePaths = useMemo(() => project.files.map((file) => file.path), [project.files]);
  return (
    <div className="flex h-full min-h-0 min-w-0" data-slot="project-files">
      <div className={cn("min-h-0 min-w-0 flex-1 flex-col", selection ? "flex" : "hidden md:flex")}>
        {selection ? (
          <>
            <div className="border-border-subtle shrink-0 border-b px-2 py-1 md:hidden">
              <Button variant="ghost" size="sm" onClick={() => onSelect(null)}>
                <ArrowLeft />
                Back to files
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <ProjectFilePane
                // Only explicit file/version navigation resets the editor. A
                // contentRevision push leaves the selected snapshot and draft intact.
                key={`${project.id}:${selection.path}:${selection.revision}:${!!selection.fromReport}`}
                projectId={project.id}
                file={{
                  ...selection,
                  editable: selection.editable && project.status !== "archived",
                }}
                onClose={() => onSelect(null)}
                onOpenFile={onSelect}
              />
            </div>
          </>
        ) : (
          <div className="text-text-muted/60 flex h-full flex-col items-center justify-center gap-3 text-xs">
            <FileText className="size-5" aria-hidden="true" />
            Select a file to preview
          </div>
        )}
      </div>
      <aside
        aria-label="Project documents"
        className={cn(
          "border-border-subtle min-h-0 w-full flex-col md:flex md:w-1/3 md:max-w-64 md:min-w-40 md:border-l",
          selection ? "hidden" : "flex"
        )}
      >
        <div className="text-text-secondary flex h-10 shrink-0 items-center px-3 text-xs font-medium">
          Files
        </div>
        <div className="min-h-0 flex-1 overflow-hidden py-1">
          {nodes.length ? (
            <FileTree
              nodes={nodes}
              selectedPath={selection?.path}
              revealPath={selection?.path}
              revealRequestId={selection ? `${selection.path}:${selection.revision}` : null}
              onFileClick={(path) =>
                onSelect({
                  path,
                  revision: project.contentRevision,
                  editable: project.status !== "archived",
                  availablePaths,
                })
              }
            />
          ) : (
            <p className="text-text-tertiary px-3 py-4 text-xs">No published files yet.</p>
          )}
        </div>
      </aside>
    </div>
  );
}
