import { useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderGit2, KeyRound, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { native } from "@/platform";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { useDeusCloudSignIn } from "@/shared/hooks/useDeusCloudSignIn";
import { queryKeys } from "@/shared/api/queryKeys";
import { RepoService } from "@/features/repository/api/repository.service";
import { githubRepoSlug } from "@shared/git-origin";
import type { CloudEnvironmentSettings } from "@shared/types/environment-secrets";
import {
  getEnvironmentInstallUrl,
  getRepositoryEnvironmentFile,
  saveCloudEnvironmentSetup,
  getEnvironmentSecretSettings,
  listEnvironmentRepositories,
  listSecretOrganizations,
} from "../../api/environment-secrets.service";
import {
  environmentRepositories,
  type EnvironmentRepository,
} from "../../lib/environment-repositories";
import { CloudApplicationSecrets, ENVIRONMENT_SECRETS_QUERY_KEY } from "./CloudApplicationSecrets";
import { ProjectEnvironmentEditor } from "./ProjectEnvironmentEditor";
import { SetUpEnvironmentWithAgent } from "./SetUpEnvironmentWithAgent";

export function EnvironmentSection() {
  const session = useDeusCloudSession();
  const accountId = session.data?.signedIn ? session.data.accountId : null;
  return <EnvironmentSettings key={accountId ?? "signed-out"} accountId={accountId} />;
}
function EnvironmentSettings({ accountId }: { accountId: string | null }) {
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const organizations = useQuery({
    queryKey: [...ENVIRONMENT_SECRETS_QUERY_KEY, accountId, "orgs"],
    queryFn: ({ signal }) => listSecretOrganizations(signal),
    enabled: !!accountId,
    staleTime: 30_000,
    retry: false,
  });
  const orgId =
    selectedOrg ??
    organizations.data?.currentOrganizationId ??
    organizations.data?.items[0]?.id ??
    null;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Environments</h3>
          <p className="text-text-muted mt-1 text-sm">Set up how your repositories run.</p>
        </div>
        {(organizations.data?.items.length ?? 0) > 1 && (
          <Select
            value={orgId ?? ""}
            onValueChange={(id) => {
              if (dirty && !window.confirm("Discard unsaved setup changes?")) return;
              setDirty(false);
              setSelectedOrg(id);
            }}
          >
            <SelectTrigger aria-label="Organization" className="w-auto max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {organizations.data!.items.map((org) => (
                <SelectItem key={org.id} value={org.id}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {organizations.isError && (
        <LoadError error={organizations.error} retry={() => void organizations.refetch()} />
      )}
      <RepositoryEnvironments
        key={orgId ?? "local"}
        accountId={accountId}
        orgId={orgId}
        cloudLoading={!!accountId && organizations.isPending}
        dirty={dirty}
        setDirty={setDirty}
        activeOrganization={orgId === organizations.data?.currentOrganizationId}
      />
    </div>
  );
}
function RepositoryEnvironments({
  accountId,
  orgId,
  cloudLoading,
  dirty,
  setDirty,
  activeOrganization,
}: {
  accountId: string | null;
  orgId: string | null;
  cloudLoading: boolean;
  dirty: boolean;
  setDirty: (dirty: boolean) => void;
  activeOrganization: boolean;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("cloud");
  const signIn = useDeusCloudSignIn();
  const repos = useQuery({
    queryKey: queryKeys.repos.all,
    queryFn: () => RepoService.fetchAll(),
    enabled: !isCloudDirectWebMode(),
    staleTime: 10_000,
  });
  const settings = useQuery({
    queryKey: [...ENVIRONMENT_SECRETS_QUERY_KEY, accountId, orgId, null],
    queryFn: ({ signal }) => getEnvironmentSecretSettings(orgId!, null, signal),
    enabled: !!orgId,
    staleTime: 30_000,
    retry: false,
  });
  const github = useQuery({
    queryKey: [...ENVIRONMENT_SECRETS_QUERY_KEY, accountId, orgId, "github-repos"],
    queryFn: ({ signal }) => listEnvironmentRepositories(orgId!, signal),
    enabled: !!orgId,
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
  function navigate(next: EnvironmentRepository | "defaults" | null) {
    if (dirty && !window.confirm("Discard unsaved setup changes?")) return;
    setDirty(false);
    setSelectedKey(typeof next === "object" ? (next?.key ?? null) : next);
    if (next && next !== "defaults")
      setTab(
        orgId && (next.environment || canAccess(next)) ? "cloud" : next.local ? "local" : "cloud"
      );
  }
  const rows = environmentRepositories(
    repos.data ?? [],
    github.data?.repos ?? [],
    settings.data?.environments ?? []
  );
  const selection =
    selectedKey === "defaults" ? "defaults" : rows.find((row) => row.key === selectedKey);
  const canAccess = (row: EnvironmentRepository) => {
    const slug = row.repo && githubRepoSlug(row.repo)?.toLowerCase();
    return !!slug && !!github.data?.repos.some((name) => name.toLowerCase() === slug);
  };
  if (selection)
    return (
      <div className="space-y-6">
        <nav
          aria-label="Environment breadcrumb"
          className="text-text-muted flex min-w-0 items-center gap-2 text-sm"
        >
          <button
            type="button"
            className="hover:text-text-primary shrink-0 py-1"
            onClick={() => navigate(null)}
          >
            Repositories
          </button>
          <ChevronRight className="size-3.5 shrink-0" />
          <span aria-current="page" className="text-text-primary truncate">
            {selection === "defaults" ? "Default secrets" : selection.name}
          </span>
        </nav>
        {selection === "defaults" ? (
          <>
            <div>
              <h4 className="font-medium">Default secrets</h4>
              <p className="text-text-muted mt-1 text-sm">
                Available across repositories in this organization. A repository’s own value takes
                priority.
              </p>
            </div>
            {orgId && settings.data && (
              <CloudApplicationSecrets
                orgId={orgId}
                environmentId={null}
                settings={settings.data}
                onDefaults={() => {}}
              />
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <RepositoryAvatar repo={selection.repo} />
                <h4 className="min-w-0 text-base font-medium break-all">{selection.name}</h4>
              </div>
              <div className="flex items-center gap-2">
                <Select value={tab} onValueChange={setTab}>
                  <SelectTrigger aria-label="Setup workspace location" className="w-auto">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cloud" disabled={!orgId}>
                      Cloud
                    </SelectItem>
                    <SelectItem value="local" disabled={!selection.local?.root_path}>
                      Local
                    </SelectItem>
                  </SelectContent>
                </Select>
                <SetUpEnvironmentWithAgent
                  repoId={selection.local?.id}
                  location={tab === "local" ? "local" : "cloud"}
                  activeOrganization={activeOrganization}
                  onBeforeStart={() => {
                    if (dirty && !window.confirm("Discard unsaved setup changes?")) return false;
                    setDirty(false);
                    return true;
                  }}
                />
              </div>
            </div>
            <RepositoryEnvironmentSettings
              key={selection.key}
              accountId={accountId}
              orgId={orgId}
              repository={selection}
              access={canAccess(selection)}
              accessUnknown={!github.data}
              onDirtyChange={setDirty}
              onDefaults={() => navigate("defaults")}
            />
          </>
        )}
      </div>
    );
  return (
    <div className="space-y-4">
      {!accountId && <CloudSignIn onSignIn={() => signIn.mutate()} pending={signIn.isPending} />}
      {settings.isError && (
        <LoadError error={settings.error} retry={() => void settings.refetch()} />
      )}
      {github.isError && <LoadError error={github.error} retry={() => void github.refetch()} />}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="text-text-muted pointer-events-none absolute top-3 left-3 size-4" />
          <Input
            aria-label="Search repositories"
            className="pl-9"
            placeholder="Search repositories…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {orgId && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate("defaults")}
              disabled={!settings.data}
            >
              <KeyRound className="mr-1.5 size-3.5" />
              Default secrets
            </Button>
            <ConnectRepositories orgId={orgId} accountId={accountId!} />
          </>
        )}
      </div>
      <div className="border-border-subtle overflow-hidden rounded-lg border">
        <div className="bg-bg-muted text-text-muted grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-4 py-2 text-xs sm:grid-cols-[minmax(0,1fr)_140px_80px]">
          <span>Repository</span>
          <span>Cloud</span>
          <span className="hidden sm:block">Local</span>
        </div>
        <div className="divide-border-subtle divide-y">
          {rows
            .filter((row) => row.name.toLowerCase().includes(search.toLowerCase()))
            .map((row) => (
              <button
                key={row.key}
                type="button"
                className="hover:bg-bg-muted focus-visible:bg-bg-muted grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-4 text-left transition-colors outline-none sm:grid-cols-[minmax(0,1fr)_140px_80px]"
                onClick={() => navigate(row)}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <RepositoryAvatar repo={row.repo} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{row.name}</span>
                    {row.environment && !row.environment.isRepositoryDefault && (
                      <span className="text-text-muted text-xs">
                        {row.environment.ownerType === "USER"
                          ? "Personal setup"
                          : "Additional setup"}{" "}
                        · {row.environment.name}
                      </span>
                    )}
                    {row.local && (
                      <span
                        className="text-text-muted block truncate text-xs"
                        title={row.local.root_path}
                      >
                        {row.local.root_path}
                      </span>
                    )}
                  </span>
                </span>
                <span
                  className={`flex items-center gap-1.5 text-xs ${row.environment ? "text-text-secondary" : "text-text-muted"}`}
                >
                  {row.environment
                    ? "Setup saved"
                    : !accountId
                      ? "Sign in"
                      : cloudLoading || github.isLoading
                        ? "Checking…"
                        : !orgId || github.isError
                          ? "Unavailable"
                          : canAccess(row)
                            ? "Set up"
                            : row.repo
                              ? "Connect GitHub"
                              : "No remote"}
                  <ChevronRight className="size-3" />
                </span>
                <span className="text-text-muted hidden text-xs sm:block">
                  {row.local ? "Available" : "—"}
                </span>
              </button>
            ))}
        </div>
        {!rows.length && (
          <p role="status" className="text-text-muted px-4 py-10 text-center text-sm">
            {cloudLoading || settings.isLoading || repos.isLoading
              ? "Loading repositories…"
              : "Connect GitHub or add a local project to get started."}
          </p>
        )}
        {!!rows.length &&
          !rows.some((row) => row.name.toLowerCase().includes(search.toLowerCase())) && (
            <p className="text-text-muted px-4 py-8 text-center text-sm">
              No repositories match your search.
            </p>
          )}
      </div>
      <p className="text-text-muted text-xs">
        Cloud access comes from the Deus GitHub App. Local setup is available for repositories on
        this computer.
      </p>
    </div>
  );
}
function RepositoryAvatar({ repo }: { repo: string | null }) {
  const owner = repo ? githubRepoSlug(repo)?.split("/")[0] : null;
  return (
    <Avatar className="size-6 rounded-md" aria-hidden="true">
      {owner && (
        <AvatarImage
          src={`https://github.com/${encodeURIComponent(owner)}.png?size=48`}
          alt=""
          referrerPolicy="no-referrer"
        />
      )}
      <AvatarFallback className="text-text-muted rounded-md">
        <FolderGit2 className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}
function RepositoryEnvironmentSettings({
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
    queryKey: [...ENVIRONMENT_SECRETS_QUERY_KEY, accountId, orgId, environmentId],
    queryFn: ({ signal }) => getEnvironmentSecretSettings(orgId!, environmentId, signal),
    enabled: !!orgId,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
  const file = useQuery({
    queryKey: [...ENVIRONMENT_SECRETS_QUERY_KEY, accountId, orgId, "file", repository.key],
    queryFn: ({ signal }) =>
      local
        ? RepoService.fetchEnvironmentFile(local.id)
        : getRepositoryEnvironmentFile(orgId!, slug!, signal),
    enabled: !!local || (!!orgId && !!slug && access),
    staleTime: 0,
    retry: false,
  });
  if (settings.isError)
    return <LoadError error={settings.error} retry={() => void settings.refetch()} />;
  if (file.isError) return <LoadError error={file.error} retry={() => void file.refetch()} />;
  if (settings.isLoading || file.isLoading)
    return (
      <p role="status" className="text-text-muted text-sm">
        Loading project environment…
      </p>
    );
  const selected = settings.data?.selectedEnvironment;
  const project = file.data?.project ?? selected?.project ?? { version: 1 };
  const fromFile = !!file.data?.project;
  const canEdit = fromFile
    ? !!local
    : settings.data
      ? (selected?.canEdit ?? settings.data.canManageShared)
      : !!local;
  const fileKnown = !!file.data || !repository.repo;
  const sourceLabel = fromFile
    ? `.deus/environment.json · ${file.data?.branch ?? "current branch"}${local ? " · Local checkout; publish changes through Git." : " · Add this repository to Deus, then open a setup workspace to edit and publish this file."}`
    : !orgId
      ? "Local repository file · Publish through Git to share with your team."
      : "Saved project settings · Shared across future local and cloud workspaces.";
  return (
    <div className="space-y-5">
      {!access && orgId && !local && (
        <div className="bg-bg-muted flex flex-wrap items-center justify-between gap-3 rounded-lg p-3">
          <p className="text-text-muted text-xs">
            {accessUnknown
              ? "Checking repository access…"
              : "Connect GitHub to read this repository's environment."}
          </p>
          <ConnectRepositories orgId={orgId} accountId={accountId!} />
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
          canExport={!!local && !fromFile && !!orgId}
          onDirtyChange={onDirtyChange}
          onSave={async (next, exportFile, signal) => {
            if ((fromFile || exportFile || !orgId || !repository.repo) && local) {
              await RepoService.saveEnvironmentFile(local.id, next);
              if (signal.aborted) return;
              await file.refetch();
            } else if (orgId && (repository.repo || environmentId)) {
              const result = await saveCloudEnvironmentSetup(
                orgId,
                environmentId ? { environmentId } : { repo: repository.repo! },
                next,
                signal
              );
              if (signal.aborted) return;
              queryClient.setQueryData<CloudEnvironmentSettings>(
                [...ENVIRONMENT_SECRETS_QUERY_KEY, accountId, orgId, result.id],
                (previous) =>
                  previous?.selectedEnvironment
                    ? {
                        ...previous,
                        selectedEnvironment: { ...previous.selectedEnvironment, project: next },
                      }
                    : previous
              );
            }
            await queryClient.invalidateQueries({ queryKey: ENVIRONMENT_SECRETS_QUERY_KEY });
            await queryClient.invalidateQueries({ queryKey: ["workspaces", "environment"] });
          }}
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
function ConnectRepositories({ orgId, accountId }: { orgId: string; accountId: string }) {
  const install = useQuery({
    queryKey: [...ENVIRONMENT_SECRETS_QUERY_KEY, accountId, orgId, "github-install"],
    queryFn: ({ signal }) => getEnvironmentInstallUrl(orgId, signal),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  if (install.isError)
    return (
      <Button size="sm" variant="outline" onClick={() => void install.refetch()}>
        Retry GitHub connection
      </Button>
    );
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!install.data}
      onClick={() => {
        if (install.data) void native.window.openExternal(install.data.url);
      }}
    >
      Install GitHub App
    </Button>
  );
}
function CloudSignIn({ onSignIn, pending }: { onSignIn: () => void; pending: boolean }) {
  return (
    <div className="border-border-subtle flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <p className="text-text-muted text-sm">
        Sign in to configure cloud environments and secrets.
      </p>
      <Button size="sm" onClick={onSignIn} disabled={pending}>
        Sign in to Deus Cloud
      </Button>
    </div>
  );
}
function LoadError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div role="alert" className="space-y-2">
      <p className="text-destructive text-sm">{error.message}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}
