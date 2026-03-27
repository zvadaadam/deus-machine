import { useState, useMemo } from "react";
import { Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useRepoBranches } from "../api/workspace.queries";
import { cn } from "@/shared/lib/utils";

interface BranchSelectorProps {
  repoId: string | null;
  currentBranch: string;
  onBranchSelect: (branch: string) => void;
  children: React.ReactNode;
}

/**
 * Branch selector popover — shows available branches with search filtering.
 * Wraps a trigger element (the right side of a split button).
 * Uses useRepoBranches to fetch remote + local branches via WebSocket.
 */
export function BranchSelector({
  repoId,
  currentBranch,
  onBranchSelect,
  children,
}: BranchSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Only fetch when popover is open — avoids unnecessary WS requests on mount
  const { data, isLoading, isError, error, refetch } = useRepoBranches(open ? repoId : null);

  const branches = useMemo(() => {
    const raw = data?.branches ?? [];
    return raw.filter((b) => b.name !== "HEAD" && b.name !== "origin");
  }, [data]);

  const filtered = useMemo(() => {
    if (!search) return branches;
    const q = search.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, search]);

  const handleSelect = (name: string) => {
    onBranchSelect(name);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSearch("");
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[220px] p-0">
        {/* Search input */}
        <div className="border-border-subtle flex items-center gap-2 border-b px-3 py-2">
          <Search className="text-text-muted h-3 w-3 flex-shrink-0" />
          <input
            type="text"
            placeholder="Search branches..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="text-text-secondary placeholder:text-text-disabled w-full bg-transparent text-xs outline-none"
            autoFocus
          />
        </div>

        {/* Branch list */}
        <div className="max-h-[200px] overflow-y-auto p-1">
          {isLoading ? (
            <p className="text-text-muted px-2 py-3 text-center text-xs">Loading...</p>
          ) : isError ? (
            <div className="px-2 py-3 text-center">
              <p className="text-text-muted text-xs">Failed to load branches</p>
              <p className="text-text-disabled text-2xs mt-0.5">{error?.message}</p>
              <button
                type="button"
                onClick={() => refetch()}
                className="text-primary mt-1 text-xs hover:underline"
              >
                Retry
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-text-muted px-2 py-3 text-center text-xs">
              {search ? "No matching branches" : "No branches available"}
            </p>
          ) : (
            filtered.map((branch) => {
              const isLocalOnly = branch.is_local === true && branch.is_remote !== true;
              return (
                <button
                  key={branch.name}
                  type="button"
                  onClick={() => handleSelect(branch.name)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors duration-150",
                    branch.name === currentBranch
                      ? "text-primary font-medium"
                      : "text-text-secondary hover:bg-bg-muted"
                  )}
                >
                  <span className="truncate">
                    {isLocalOnly ? (
                      branch.name
                    ) : (
                      <>
                        <span className="text-text-disabled">origin/</span>
                        {branch.name}
                      </>
                    )}
                  </span>
                  {isLocalOnly && (
                    <span className="text-text-disabled text-2xs flex-shrink-0">local</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
