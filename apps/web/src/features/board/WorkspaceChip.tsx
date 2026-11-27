import { GitBranch } from "lucide-react";
import { LabelPill } from "@/components/ui/label-pill";
import { linkToWorkspace } from "@/features/workspace/lib/workspaceAddress";
import { showWorkspace } from "@/features/workspace/lib/openWorkspace";

export function WorkspaceChip({
  id,
  name,
  archived,
}: {
  id: string | null;
  name: string;
  archived?: boolean;
}) {
  const content = (
    <>
      <GitBranch aria-hidden />
      <span>{name}</span>
    </>
  );
  if (!id || archived)
    return (
      <LabelPill size="sm" title={name}>
        {content}
      </LabelPill>
    );
  return (
    <LabelPill size="sm" asChild>
      <a
        href={linkToWorkspace({ workspaceId: id })}
        aria-label={`Open workspace, ${name}`}
        onClick={(event) => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          showWorkspace(id);
        }}
      >
        {content}
      </a>
    </LabelPill>
  );
}
