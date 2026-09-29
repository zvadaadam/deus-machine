import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui";
import { uiActions } from "@/shared/stores/uiStore";

/** Available in every workspace view, including when its conversation is hidden. */
export function ProjectBackLink({
  projectId,
  projectTitle,
}: {
  projectId: string;
  projectTitle?: string | null;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      className="no-drag text-text-secondary mr-1 shrink-0"
      aria-label={`Back to ${projectTitle ?? "project"}`}
      title={projectTitle ?? "Back to project"}
      onClick={() => uiActions.openProjects(projectId)}
    >
      <ArrowLeft className="size-3.5" />
      Project
    </Button>
  );
}
