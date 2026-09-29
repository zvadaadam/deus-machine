import { useRef } from "react";
import type { CreateProjectInput } from "@shared/projects";
import type { Repository } from "@/features/repository/types";
import { NewWorkspacePromptModal } from "@/features/repository/ui/NewWorkspacePromptModal";
import { getErrorMessage } from "@shared/lib/errors";
import { useCreateProject } from "../api/projects.queries";

export function NewProjectDialog({
  repos,
  selectedRepoId,
  onRepoChange,
  onClose,
  onCreated,
}: {
  repos: Repository[];
  selectedRepoId: string;
  onRepoChange: (repoId: string) => void;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateProject();
  const pending = useRef<{ key: string; request: CreateProjectInput } | null>(null);
  return (
    <NewWorkspacePromptModal
      show
      kind="project"
      repos={repos}
      selectedRepoId={selectedRepoId}
      onRepoChange={onRepoChange}
      creating={create.isPending}
      onClose={() => {
        if (!create.isPending) onClose();
      }}
      error={create.isError ? getErrorMessage(create.error) : undefined}
      onSubmit={async ({ repoId, prompt, model, title }) => {
        const brief = prompt.trim();
        if (!repoId || create.isPending) return;
        // Name first, then the brief's first line, then the repository — a
        // Project is never blocked on wording; the coordinator asks for the rest.
        const name =
          title?.trim() ||
          brief.split(/\r?\n/, 1)[0].trim().slice(0, 120) ||
          repos.find((repo) => repo.id === repoId)?.name ||
          "New project";
        const key = JSON.stringify({ repoId, brief, model, name });
        if (pending.current?.key !== key) {
          pending.current = {
            key,
            request: {
              requestId: crypto.randomUUID(),
              repositoryId: repoId,
              title: name,
              brief,
              model,
            },
          };
        }
        try {
          const project = await create.mutateAsync(pending.current.request);
          onCreated(project.id);
        } catch {
          // The modal keeps the prompt; an unchanged retry keeps its request ID.
        }
      }}
    />
  );
}
