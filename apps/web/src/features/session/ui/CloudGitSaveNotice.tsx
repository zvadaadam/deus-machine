import { CloudAlert, CloudUpload } from "lucide-react";
import type { Session } from "@shared/types/session";
import { sessionComposerActions } from "../store/sessionComposerStore";

export function CloudGitSaveNotice({ session }: { session: Session }) {
  const error = session.cloud_git_error;
  if (!error) {
    if (session.cloud_git_sync_at != null || !session.message_count || session.status === "working")
      return null;
    return (
      <p role="status" className="text-text-muted mb-2 flex items-center gap-2 px-3 text-xs">
        <CloudUpload aria-hidden="true" className="size-3.5 shrink-0" />
        Git backup status is unavailable for this chat.
      </p>
    );
  }

  return (
    <aside
      role="status"
      aria-label="Git backup needs attention"
      className="border-border-subtle bg-bg-raised mb-2 flex gap-2 rounded-lg border p-3 text-xs"
    >
      <CloudAlert aria-hidden="true" className="text-warning mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-text-primary font-medium">Git backup needs attention</p>
        <p className="text-text-secondary">
          The last backup in this chat reported a problem. Recent file changes may be missing if
          this cloud computer is recreated. Backups retry after each agent reply.
        </p>
        <details className="text-text-secondary">
          <summary className="w-fit cursor-pointer">View backup error</summary>
          <p className="mt-1 max-h-28 overflow-auto wrap-anywhere whitespace-pre-wrap">{error}</p>
        </details>
        <button
          type="button"
          onClick={() =>
            sessionComposerActions.appendDraft(
              session.id,
              `Help me diagnose the automatic cloud Git backup failure and preserve my current work. Do not reset files, replace the recovery ref, or force-push over saved work. Explain any account or repository access I need to fix.\n\nBackup diagnostic: ${JSON.stringify(error)}`
            )
          }
          className="text-text-primary hover:text-text-secondary w-fit underline underline-offset-2"
        >
          Draft a recovery request
        </button>
      </div>
    </aside>
  );
}
