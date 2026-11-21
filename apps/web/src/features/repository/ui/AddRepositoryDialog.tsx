/**
 * Add a GitHub repository as a project, in the cloud: nothing is cloned and
 * no folder is asked for. Lists the repositories the organization's GitHub
 * App can reach (`cloudRepositories`), or takes a public repository's address.
 * A repository that is already a project just opens it.
 */
import { useState } from "react";
import { match } from "ts-pattern";
import { AlertCircle, Check, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { canInstallGithubApp, installGithubApp } from "@/platform/native/deus-cloud";
import { useCloudOrganizations } from "@/shared/hooks/useCloudOrganizations";
import { GitHubIcon } from "@/shared/components/icons/GitHubIcon";
import { cn } from "@/shared/lib/utils";
import { getErrorMessage } from "@shared/lib/errors";
import { useAddCloudRepo, useCloudRepositories } from "../api/repository.queries";
import { cloudRepositoriesView, publicRepositoryInput } from "../lib/addProject";

interface AddRepositoryDialogProps {
  open: boolean;
  /** The organization whose GitHub access lists the repositories; the default one when null. */
  organizationId: string | null;
  onClose: () => void;
  /** A repository was added, or chosen as the project it already is. */
  onAdded: (repoId: string) => void;
  /** The projects there are, so an address that names one opens it. */
  projects: readonly { repo_id: string; git_origin_url?: string | null }[];
}

export function AddRepositoryDialog({
  open,
  organizationId,
  onClose,
  onAdded,
  projects,
}: AddRepositoryDialogProps) {
  const organizations = useCloudOrganizations();
  const items = organizations?.items ?? [];
  const organizationName =
    items.length > 1 ? (items.find((org) => org.id === organizationId)?.name ?? null) : null;

  const [filter, setFilter] = useState("");
  const [publicOpen, setPublicOpen] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useCloudRepositories(organizationId, open);
  const addMutation = useAddCloudRepo();
  const view = cloudRepositoriesView(query, filter);
  const canConnect = canInstallGithubApp();

  const close = () => {
    setFilter("");
    setPublicOpen(false);
    setPublicUrl("");
    setError(null);
    setAdding(null);
    onClose();
  };

  const add = async (repository: string) => {
    setAdding(repository);
    setError(null);
    try {
      const repo = await addMutation.mutateAsync({ repository, organizationId });
      close();
      onAdded(repo.id);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setAdding(null);
    }
  };

  const choose = (repo: { slug: string; repoId: string | null }) => {
    if (repo.repoId) {
      close();
      onAdded(repo.repoId);
      return;
    }
    void add(repo.slug);
  };

  const connect = async () => {
    const result = await installGithubApp(organizationId);
    if (!result.ok) {
      toast.error("Couldn't open GitHub", {
        description: result.error ?? "Connect GitHub from the Deus app on your Mac.",
      });
    }
  };

  const busy = adding !== null;
  const typed = publicRepositoryInput(publicUrl, projects);
  const submitPublic = () =>
    match(typed)
      .with({ kind: "existing" }, ({ repoId }) => {
        close();
        onAdded(repoId);
      })
      .with({ kind: "new" }, ({ slug }) => void add(slug))
      .with({ kind: "empty" }, { kind: "invalid" }, () => {})
      .exhaustive();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="gap-4 sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Add repository</DialogTitle>
          <DialogDescription className="text-text-muted text-xs">
            {organizationName
              ? `Repositories ${organizationName}'s GitHub access can reach. Nothing is cloned to this Mac.`
              : "Repositories your organization's GitHub access can reach. Nothing is cloned to this Mac."}
          </DialogDescription>
        </DialogHeader>

        <div className="border-border-subtle overflow-hidden rounded-lg border">
          <div className="border-border-subtle flex items-center gap-2 border-b px-3 py-2">
            <Search className="text-text-disabled size-3.5 shrink-0" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search repositories..."
              aria-label="Search repositories"
              className="text-text-primary placeholder:text-text-disabled w-full bg-transparent text-sm outline-none"
              autoFocus
            />
          </div>

          <div className="max-h-[260px] min-h-[120px] overflow-y-auto py-1">
            {match(view)
              .with({ kind: "loading" }, () => (
                <div className="text-text-muted flex items-center justify-center gap-2 px-3 py-8 text-sm">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading repositories…
                </div>
              ))
              .with({ kind: "error" }, ({ message }) => (
                <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
                  <p className="text-text-muted text-sm">{message}</p>
                  <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                    Retry
                  </Button>
                </div>
              ))
              .with({ kind: "empty" }, () => (
                <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
                  <p className="text-text-muted text-sm text-balance">
                    {organizationName ? `${organizationName}'s` : "Your organization's"} GitHub
                    access reaches no repositories yet.
                  </p>
                  {canConnect ? (
                    <Button size="sm" className="gap-1.5" onClick={() => void connect()}>
                      <GitHubIcon className="size-3.5" />
                      Connect GitHub
                    </Button>
                  ) : (
                    <p className="text-text-disabled text-xs text-balance">
                      Connect GitHub from the Deus app on your Mac, or use a public repository.
                    </p>
                  )}
                </div>
              ))
              .with({ kind: "list" }, ({ repositories }) =>
                repositories.length === 0 ? (
                  <div className="text-text-disabled px-3 py-6 text-center text-sm">
                    No repositories match
                  </div>
                ) : (
                  repositories.map((repo) => (
                    <button
                      key={repo.slug}
                      type="button"
                      disabled={busy}
                      onClick={() => choose(repo)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors",
                        "hover:bg-bg-raised/45 text-text-secondary disabled:cursor-default"
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <GitHubIcon className="text-text-disabled size-3.5 shrink-0" />
                        <span className="truncate font-medium">{repo.slug}</span>
                      </span>
                      {adding === repo.slug ? (
                        <Loader2 className="text-text-muted size-3.5 shrink-0 animate-spin" />
                      ) : repo.repoId ? (
                        <span className="text-text-disabled flex shrink-0 items-center gap-1 text-xs">
                          <Check className="size-3" />
                          Added
                        </span>
                      ) : null}
                    </button>
                  ))
                )
              )
              .exhaustive()}
          </div>
        </div>

        {publicOpen ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2">
              <Input
                placeholder="https://github.com/owner/repo"
                aria-label="Public repository address"
                value={publicUrl}
                onChange={(e) => {
                  setPublicUrl(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) submitPublic();
                }}
                disabled={busy}
                autoFocus
                className="flex-1"
              />
              <Button
                onClick={submitPublic}
                disabled={busy || typed.kind === "empty" || typed.kind === "invalid"}
              >
                {typed.kind === "new" && adding === typed.slug ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : typed.kind === "existing" ? (
                  "Open"
                ) : (
                  "Add"
                )}
              </Button>
            </div>
            {match(typed)
              .with({ kind: "existing" }, ({ slug }) => (
                <p className="text-text-muted flex items-center gap-1 text-xs">
                  <Check className="size-3" />
                  {slug} is already a project.
                </p>
              ))
              .with({ kind: "invalid" }, () => (
                <p className="text-text-disabled text-xs">
                  Use owner/name or a github.com address.
                </p>
              ))
              .with({ kind: "empty" }, { kind: "new" }, () => null)
              .exhaustive()}
          </div>
        ) : null}

        {error && (
          <div className="bg-destructive/10 flex items-start gap-2 rounded-lg px-3 py-2.5">
            <AlertCircle className="text-destructive mt-0.5 size-3.5 shrink-0" />
            <p className="text-destructive text-sm">{error}</p>
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          {!publicOpen ? (
            <button
              type="button"
              onClick={() => setPublicOpen(true)}
              className="text-text-muted hover:text-text-secondary text-xs transition-colors"
            >
              Use a public repository
            </button>
          ) : (
            <span />
          )}
          {canConnect && (
            <button
              type="button"
              onClick={() => void connect()}
              className="text-text-disabled hover:text-text-muted text-xs transition-colors"
            >
              Manage GitHub access
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
