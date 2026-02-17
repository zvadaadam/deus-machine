import { useState, useMemo } from "react";
import { Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useBranches } from "../api/workspace.queries";
import { cn } from "@/shared/lib/utils";

interface BranchSelectorProps {
  workspacePath: string | null;
  currentBranch: string;
  onBranchSelect: (branch: string) => void;
  children: React.ReactNode;
}

/**
 * Branch selector popover — shows available branches with search filtering.
 * Wraps a trigger element (the right side of a split button).
 * Uses Tauri IPC to list branches; gracefully empty in browser/Storybook.
 */
export function BranchSelector({
  workspacePath,
  currentBranch,
  onBranchSelect,
  children,
}: BranchSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data: branches = [], isLoading } = useBranches(open ? workspacePath : null);

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        className="w-[220px] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
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
          ) : filtered.length === 0 ? (
            <p className="text-text-muted px-2 py-3 text-center text-xs">
              {search ? "No matching branches" : "No branches available"}
            </p>
          ) : (
            filtered.map((branch) => (
              <button
                key={branch.name}
                type="button"
                onClick={() => handleSelect(branch.name)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors duration-150",
                  branch.name === currentBranch
                    ? "text-primary font-medium"
                    : "text-text-secondary hover:bg-bg-muted"
                )}
              >
                <span className="truncate">{branch.name}</span>
                {branch.is_remote && (
                  <span className="text-text-disabled flex-shrink-0 text-2xs">remote</span>
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
