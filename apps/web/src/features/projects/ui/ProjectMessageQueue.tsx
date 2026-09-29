import { toast } from "sonner";
import type { ProjectDetail } from "@shared/projects";
import { Button } from "@/components/ui";
import { getErrorMessage } from "@shared/lib/errors";
import { useProjectAction } from "../api/projects.queries";

/** Only undispatched human messages can be removed; running turns keep their frozen input. */
export function ProjectMessageQueue({
  project,
  agentId,
}: {
  project: ProjectDetail;
  agentId?: string;
}) {
  const action = useProjectAction(project.id);
  const messages = (project.pendingMessages ?? []).filter(
    (message) => !agentId || message.agentId === agentId
  );
  if (!messages.length) return null;
  return (
    <details className="border-border-subtle mb-3 rounded-lg border text-xs" open>
      <summary className="control-interaction text-text-secondary cursor-pointer rounded-lg px-3 py-2 font-medium">
        Queued messages · {messages.length}
      </summary>
      <div className="max-h-48 overflow-y-auto px-3 pb-2">
        <p className="text-text-tertiary mb-2 leading-relaxed">
          Saved until this agent can continue. Remove a message to replace it before it starts.
        </p>
        {messages.map((message) => (
          <div key={message.id} className="border-border-subtle border-t py-2">
            {!agentId && (
              <p className="text-text-tertiary mb-1 truncate">
                {project.agents.find((agent) => agent.id === message.agentId)?.title ?? "Agent"}
              </p>
            )}
            <p className="text-text-secondary leading-relaxed break-words whitespace-pre-wrap">
              {message.message}
            </p>
            {project.status !== "archived" && (
              <Button
                variant="ghost"
                size="xs"
                className="mt-1"
                disabled={action.isPending}
                aria-label={`Remove queued message: ${message.message.slice(0, 80)}`}
                onClick={() =>
                  action.mutate(
                    {
                      action: "cancel-input",
                      inputId: message.id,
                      requestId: crypto.randomUUID(),
                    },
                    { onError: (error) => toast.error(getErrorMessage(error)) }
                  )
                }
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        {project.pendingMessageCount > 50 && (
          <p className="text-text-tertiary mt-2">Showing the first 50 queued messages.</p>
        )}
      </div>
    </details>
  );
}
