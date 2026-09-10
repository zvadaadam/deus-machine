import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectEnvironment } from "@deus-hq/api";
import { queryKeys } from "@/shared/api/queryKeys";
import { RepoService } from "@/features/repository/api/repository.service";
import { githubRepoSlug } from "@shared/git-origin";
import {
  getEnvironmentSecretSettings,
  getRepositoryEnvironmentFile,
  saveCloudEnvironmentSetup,
} from "../../api/environment-secrets.service";
import type { EnvironmentRepository } from "../../lib/environment-repositories";
import { CloudApplicationSecrets } from "./CloudApplicationSecrets";
import { ConnectEnvironmentRepositories } from "./ConnectEnvironmentRepositories";
import { EnvironmentSettingsError } from "./EnvironmentSettingsError";
import { ProjectEnvironmentEditor } from "./ProjectEnvironmentEditor";

const EMPTY_PROJECT: ProjectEnvironment = { version: 1 };

export function RepositoryEnvironmentSettings({
  accountId,
  orgId,
  repository,
  access,
  accessUnknown,
  onDirtyChange,
  onDefaults,
}: {
  accountId: string | null;
  orgId: string | null;
  repository: EnvironmentRepository;
  access: boolean;
  accessUnknown: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onDefaults: () => void;
}) {
  const queryClient = useQueryClient();
  const environmentId = repository.environment?.id ?? null;
  const local = repository.local?.root_path ? repository.local : null;
  const slug = repository.repo ? githubRepoSlug(repository.repo) : null;
  const settings = useQuery({
    queryKey: queryKeys.settings.environments.detail(accountId, orgId, environmentId),
    queryFn: ({ signal }) => getEnvironmentSecretSettings(orgId!, environmentId, signal),
    enabled: !!orgId,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
  const file = useQuery({
    queryKey: queryKeys.settings.environments.repositoryFile(accountId, orgId, repository.key),
    queryFn: ({ signal }) =>
      local
        ? RepoService.fetchEnvironmentFile(local.id)
        : getRepositoryEnvironmentFile(orgId!, slug!, signal),
    enabled: !!local || (!!orgId && !!slug && access),
    staleTime: 0,
    retry: false,
  });
  if (settings.isError)
    return (
      <EnvironmentSettingsError error={settings.error} retry={() => void settings.refetch()} />
    );
  if (file.isError)
    return <EnvironmentSettingsError error={file.error} retry={() => void file.refetch()} />;
  if (settings.isLoading || file.isLoading)
    return (
      <p role="status" className="text-text-muted text-sm">
        Loading project environment…
      </p>
    );
  const selected = settings.data?.selectedEnvironment;
  const project = file.data?.project ?? selected?.project ?? EMPTY_PROJECT;
  const fromFile = !!file.data?.project;
  const savesToFile = !!local && (fromFile || !orgId || !repository.repo);
  let canEdit = savesToFile;
  if (!fromFile && !savesToFile && settings.data) {
    canEdit = selected?.canEdit ?? settings.data.canManageShared;
  }
  const fileKnown = !!file.data || !repository.repo;
  let sourceLabel = savesToFile
    ? "Local repository file · Publish through Git to share with your team."
    : "Saved project settings · Shared across future local and cloud workspaces.";
  if (fromFile) {
    const publication = local
      ? "Local checkout; publish changes through Git."
      : "Add this repository to Deus, then open a setup workspace to edit and publish this file.";
    sourceLabel = `.deus/environment.json · ${file.data?.branch ?? "current branch"} · ${publication}`;
  }
  async function saveProject(
    next: ProjectEnvironment,
    destination: "current" | "repository",
    signal: AbortSignal
  ) {
    if (local && (savesToFile || destination === "repository")) {
      await RepoService.saveEnvironmentFile(local.id, next);
    } else if (orgId && (repository.repo || environmentId)) {
      await saveCloudEnvironmentSetup(
        orgId,
        environmentId ? { environmentId } : { repo: repository.repo! },
        next,
        signal
      );
    }
    if (signal.aborted) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.environments.all }),
      queryClient.invalidateQueries({ queryKey: ["workspaces", "environment"] }),
    ]);
  }
  return (
    <div className="space-y-5">
      {!access && orgId && !local && (
        <div className="bg-bg-muted flex flex-wrap items-center justify-between gap-3 rounded-lg p-3">
          <p className="text-text-muted text-xs">
            {accessUnknown
              ? "Checking repository access…"
              : "Connect GitHub to read this repository's environment."}
          </p>
          <ConnectEnvironmentRepositories orgId={orgId} accountId={accountId!} />
        </div>
      )}
      {selected && !selected.project && (
        <p className="text-text-muted text-sm">
          This environment is configured through the SDK. Its secrets can be managed below.
        </p>
      )}
      {fileKnown && (!selected || !!selected.project || fromFile) && (
        <ProjectEnvironmentEditor
          project={project}
          sourceLabel={sourceLabel}
          canEdit={canEdit}
          canExport={!!local && !savesToFile}
          onDirtyChange={onDirtyChange}
          onSave={saveProject}
        />
      )}
      <div className="border-border-subtle border-t pt-5">
        {orgId && settings.data ? (
          <CloudApplicationSecrets
            orgId={orgId}
            environmentId={environmentId}
            repo={repository.repo ?? undefined}
            settings={settings.data}
            project={project}
            onDefaults={onDefaults}
          />
        ) : (
          <p className="text-text-muted text-sm">
            Sign in to manage cloud secrets. Local workspaces use your .env and .env.local files.
          </p>
        )}
      </div>
    </div>
  );
}
