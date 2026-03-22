import { useState, useCallback } from "react";
import { GitPullRequest, GitBranch } from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useRepoPrs, useRepoBranches, useGhStatus } from "@/features/workspace/api";
import type { PRSummary, BranchSummary } from "@shared/types";

interface GitHubPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoId: string;
  repoName: string;
  onCreateWorkspace: (params: {
    repositoryId: string;
    source_branch: string;
    pr_number?: number;
    pr_url?: string;
    pr_title?: string;
    target_branch?: string;
  }) => void;
}

export function GitHubPickerModal({
  open,
  onOpenChange,
  repoId,
  repoName,
  onCreateWorkspace,
}: GitHubPickerModalProps) {
  const [activeTab, setActiveTab] = useState<"prs" | "branches">("prs");
  const [search, setSearch] = useState("");

  // Only fetch when modal is open
  const prsQuery = useRepoPrs(open ? repoId : null);
  const branchesQuery = useRepoBranches(open ? repoId : null);
  const ghStatus = useGhStatus();

  const handlePrSelect = useCallback(
    (pr: PRSummary) => {
      onCreateWorkspace({
        repositoryId: repoId,
        source_branch: pr.branch,
        pr_number: pr.number,
        pr_url: pr.url,
        pr_title: pr.title,
        target_branch: pr.baseBranch,
      });
      onOpenChange(false);
      setSearch("");
    },
    [repoId, onCreateWorkspace, onOpenChange]
  );

  const handleBranchSelect = useCallback(
    (branch: BranchSummary) => {
      onCreateWorkspace({
        repositoryId: repoId,
        source_branch: branch.name,
      });
      onOpenChange(false);
      setSearch("");
    },
    [repoId, onCreateWorkspace, onOpenChange]
  );

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      onOpenChange(isOpen);
      if (!isOpen) {
        setSearch("");
        setActiveTab("prs");
      }
    },
    [onOpenChange]
  );

  const ghInstalled = ghStatus.data?.isInstalled !== false;
  const ghAuthenticated = ghStatus.data?.isAuthenticated !== false;

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={`New workspace from ${repoName}`}
    >
      <div className="text-muted-foreground border-border/30 border-b px-4 pt-3 pb-2 text-xs font-medium">
        {repoName}
      </div>
      <CommandInput
        placeholder={activeTab === "prs" ? "Search pull requests..." : "Search branches..."}
        value={search}
        onValueChange={setSearch}
      />
      <div className="border-border/30 border-b px-3">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "prs" | "branches")}>
          <TabsList className="h-9">
            <TabsTrigger value="prs" className="gap-1.5 px-3 text-xs">
              <GitPullRequest className="h-3.5 w-3.5" />
              Pull Requests
            </TabsTrigger>
            <TabsTrigger value="branches" className="gap-1.5 px-3 text-xs">
              <GitBranch className="h-3.5 w-3.5" />
              Branches
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <CommandList>
        <CommandEmpty>
          {activeTab === "prs" && !ghInstalled
            ? "GitHub CLI (gh) is not installed"
            : activeTab === "prs" && !ghAuthenticated
              ? "Run `gh auth login` to authenticate"
              : "No results found."}
        </CommandEmpty>

        {activeTab === "prs" && (
          <CommandGroup>
            {prsQuery.isLoading && (
              <div className="text-muted-foreground px-2 py-6 text-center text-sm">
                Loading pull requests...
              </div>
            )}
            {prsQuery.data?.map((pr) => (
              <CommandItem
                key={pr.number}
                value={`${pr.title} ${pr.branch} #${pr.number}`}
                onSelect={() => handlePrSelect(pr)}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">#{pr.number}</span>
                    <span className="truncate text-sm">{pr.title}</span>
                    {pr.isDraft && (
                      <Badge
                        variant="outline"
                        className="text-muted-foreground shrink-0 px-1.5 py-0 text-[10px]"
                      >
                        draft
                      </Badge>
                    )}
                  </div>
                  <span className="text-muted-foreground truncate text-xs">{pr.branch}</span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {activeTab === "branches" && (
          <CommandGroup>
            {branchesQuery.isLoading && (
              <div className="text-muted-foreground px-2 py-6 text-center text-sm">
                Loading branches...
              </div>
            )}
            {branchesQuery.data?.branches?.map((branch) => (
              <CommandItem
                key={branch.name}
                value={branch.name}
                onSelect={() => handleBranchSelect(branch)}
              >
                <GitBranch className="text-muted-foreground h-4 w-4 shrink-0" />
                <span className="truncate text-sm">{branch.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
