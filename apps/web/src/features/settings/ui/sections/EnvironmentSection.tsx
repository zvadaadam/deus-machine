import { useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Cloud, FolderGit2, KeyRound, Laptop, Search } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  getEnvironmentSecretSettings,
  listEnvironmentRepositories,
  listSecretOrganizations,
} from "../../api/environment-secrets.service";
import {
  environmentRepositories,
  type EnvironmentRepository,
} from "../../lib/environment-repositories";
import { CloudApplicationSecrets, ENVIRONMENT_SECRETS_QUERY_KEY } from "./CloudApplicationSecrets";
import { CloudSetupEditor } from "./CloudSetupEditor";
import { LocalEnvironmentSettings } from "./LocalEnvironmentSettings";
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
            <Tabs
              value={tab}
              onValueChange={(next) => {
                if (dirty && !window.confirm("Discard unsaved setup changes?")) return;
                setDirty(false);
                setTab(next);
              }}
            >
              <TabsList className="border-border-subtle mb-6 h-10 border-b">
                <TabsTrigger value="cloud" className="border-r-0 px-4">
                  <Cloud className="size-3.5" />
                  Cloud
                </TabsTrigger>
                <TabsTrigger value="local" className="border-r-0 px-4" disabled={!selection.local}>
                  <Laptop className="size-3.5" />
                  Local
                  {!selection.local && (
                    <span className="text-text-muted text-xs">· Not on this computer</span>
                  )}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="cloud" className="space-y-6">
                {orgId ? (
                  <CloudRepositorySettings
                    key={selection.key}
                    accountId={accountId!}
                    orgId={orgId}
                    repository={selection}
                    access={canAccess(selection)}
                    accessUnknown={!github.data}
                    onDirtyChange={setDirty}
                    onDefaults={() => navigate("defaults")}
                  />
                ) : !accountId ? (
                  <CloudSignIn onSignIn={() => signIn.mutate()} pending={signIn.isPending} />
                ) : (
                  <p role="status" className="text-text-muted text-sm">
                    {cloudLoading
                      ? "Loading cloud settings…"
                      : "Cloud settings are unavailable right now."}
                  </p>
                )}
              </TabsContent>
              <TabsContent value="local">
                {selection.local && (
                  <LocalEnvironmentSettings repoId={selection.local.id} onDirtyChange={setDirty} />
                )}
              </TabsContent>
            </Tabs>
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
function CloudRepositorySettings({
  accountId,
  orgId,
  repository,
  access,
  accessUnknown,
  onDirtyChange,
  onDefaults,
}: {
  accountId: string;
  orgId: string;
  repository: EnvironmentRepository;
  access: boolean;
  accessUnknown: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onDefaults: () => void;
}) {
  const queryClient = useQueryClient();
  const environmentId = repository.environment?.id ?? null;
  const settings = useQuery({
    queryKey: [...ENVIRONMENT_SECRETS_QUERY_KEY, accountId, orgId, environmentId],
    queryFn: ({ signal }) => getEnvironmentSecretSettings(orgId, environmentId, signal),
    // Creating the repository record while adding a secret must not unmount script drafts.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
  if (settings.isError)
    return <LoadError error={settings.error} retry={() => void settings.refetch()} />;
  if (!settings.data)
    return (
      <p role="status" className="text-text-muted text-sm">
        Loading cloud setup…
      </p>
    );
  if (!environmentId && !repository.repo)
    return (
      <div className="space-y-3">
        <p className="text-text-muted text-sm">
          Add a Git remote to this local repository to configure cloud setup.
        </p>
      </div>
    );
  const selected = settings.data.selectedEnvironment;
  return (
    <>
      {!access && repository.repo && githubRepoSlug(repository.repo) && (
        <div className="bg-bg-muted flex flex-wrap items-center justify-between gap-3 rounded-lg p-3">
          <p className="text-text-muted flex-1 text-xs">
            {accessUnknown
              ? "GitHub access hasn't been confirmed."
              : "Connect the Deus GitHub App for private repository access."}{" "}
            You can save setup now.
          </p>
          <ConnectRepositories orgId={orgId} accountId={accountId} />
        </div>
      )}
      <CloudSetupEditor
        orgId={orgId}
        environmentId={environmentId}
        repo={repository.repo}
        setup={selected?.setup ?? []}
        run={selected?.run ?? ""}
        canEdit={selected?.canEdit ?? settings.data.canManageShared}
        onDirtyChange={onDirtyChange}
        onSaved={(id, scripts) => {
          queryClient.setQueryData<CloudEnvironmentSettings>(
            [...ENVIRONMENT_SECRETS_QUERY_KEY, accountId, orgId, id],
            (previous) =>
              previous?.selectedEnvironment
                ? {
                    ...previous,
                    selectedEnvironment: { ...previous.selectedEnvironment, ...scripts },
                  }
                : previous
          );
          void queryClient.invalidateQueries({ queryKey: ENVIRONMENT_SECRETS_QUERY_KEY });
        }}
      />
      <div className="border-border-subtle border-t pt-5">
        <CloudApplicationSecrets
          orgId={orgId}
          environmentId={environmentId}
          repo={repository.repo ?? undefined}
          settings={settings.data}
          onDefaults={onDefaults}
        />
      </div>
    </>
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
