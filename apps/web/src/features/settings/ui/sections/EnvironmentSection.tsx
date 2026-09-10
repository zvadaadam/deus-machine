import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EnvironmentTarget } from "@deus-hq/api";
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
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { useDeusCloudSignIn } from "@/shared/hooks/useDeusCloudSignIn";
import { queryKeys } from "@/shared/api/queryKeys";
import { RepoService } from "@/features/repository/api/repository.service";
import { githubRepoSlug } from "@shared/git-origin";
import {
  getEnvironmentSecretSettings,
  listEnvironmentRepositories,
  listSecretOrganizations,
} from "../../api/environment-secrets.service";
import {
  environmentRepositories,
  type EnvironmentRepository,
} from "../../lib/environment-repositories";
import { CloudApplicationSecrets } from "./CloudApplicationSecrets";
import { RepositoryEnvironmentSettings } from "./RepositoryEnvironmentSettings";
import { ConnectEnvironmentRepositories } from "./ConnectEnvironmentRepositories";
import { EnvironmentSettingsError } from "./EnvironmentSettingsError";
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
    queryKey: queryKeys.settings.environments.organizations(accountId),
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
  function confirmNavigation() {
    if (dirty && !window.confirm("Discard unsaved setup changes?")) return false;
    setDirty(false);
    return true;
  }
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
              if (confirmNavigation()) setSelectedOrg(id);
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
        <EnvironmentSettingsError
          error={organizations.error}
          retry={() => void organizations.refetch()}
        />
      )}
      <RepositoryEnvironments
        key={orgId ?? "local"}
        accountId={accountId}
        orgId={orgId}
        cloudLoading={!!accountId && organizations.isPending}
        onBeforeNavigate={confirmNavigation}
        onDirtyChange={setDirty}
        activeOrganization={orgId === organizations.data?.currentOrganizationId}
      />
    </div>
  );
}
function RepositoryEnvironments({
  accountId,
  orgId,
  cloudLoading,
  onBeforeNavigate,
  onDirtyChange,
  activeOrganization,
}: {
  accountId: string | null;
  orgId: string | null;
  cloudLoading: boolean;
  onBeforeNavigate: () => boolean;
  onDirtyChange: (dirty: boolean) => void;
  activeOrganization: boolean;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [setupLocation, setSetupLocation] = useState<EnvironmentTarget>("cloud");
  const signIn = useDeusCloudSignIn();
  const repos = useQuery({
    queryKey: queryKeys.repos.all,
    queryFn: () => RepoService.fetchAll(),
    enabled: !isCloudDirectWebMode(),
    staleTime: 10_000,
  });
  const settings = useQuery({
    queryKey: queryKeys.settings.environments.detail(accountId, orgId, null),
    queryFn: ({ signal }) => getEnvironmentSecretSettings(orgId!, null, signal),
    enabled: !!orgId,
    staleTime: 30_000,
    retry: false,
  });
  const github = useQuery({
    queryKey: queryKeys.settings.environments.repositories(accountId, orgId),
    queryFn: ({ signal }) => listEnvironmentRepositories(orgId!, signal),
    enabled: !!orgId,
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
  function navigate(next: EnvironmentRepository | "defaults" | null) {
    if (!onBeforeNavigate()) return;
    setSelectedKey(typeof next === "object" ? (next?.key ?? null) : next);
    if (next && next !== "defaults") {
      const cloudAvailable = orgId && (next.environment || canAccess(next));
      setSetupLocation(cloudAvailable || !next.local ? "cloud" : "local");
    }
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
  function cloudStatus(row: EnvironmentRepository) {
    if (row.environment) return "Setup saved";
    if (!accountId) return "Sign in";
    if (cloudLoading || github.isLoading) return "Checking…";
    if (!orgId || github.isError) return "Unavailable";
    if (canAccess(row)) return "Set up";
    return row.repo ? "Connect GitHub" : "No remote";
  }
  const filteredRows = rows.filter((row) => row.name.toLowerCase().includes(search.toLowerCase()));
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
                <Select
                  value={setupLocation}
                  onValueChange={(value) => setSetupLocation(value === "local" ? "local" : "cloud")}
                >
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
                  location={setupLocation}
                  activeOrganization={activeOrganization}
                  onBeforeStart={onBeforeNavigate}
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
              onDirtyChange={onDirtyChange}
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
        <EnvironmentSettingsError error={settings.error} retry={() => void settings.refetch()} />
      )}
      {github.isError && (
        <EnvironmentSettingsError error={github.error} retry={() => void github.refetch()} />
      )}
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
            <ConnectEnvironmentRepositories orgId={orgId} accountId={accountId!} />
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
          {filteredRows.map((row) => (
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
                      {row.environment.ownerType === "USER" ? "Personal setup" : "Additional setup"}{" "}
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
                {cloudStatus(row)}
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
        {!!rows.length && !filteredRows.length && (
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
