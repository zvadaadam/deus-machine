import { useState, useRef, useEffect } from "react";
import { GitBranch, Check } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface BranchNameProps {
  branch: string;
  compact?: boolean;
}

export function BranchName({ branch, compact = false }: BranchNameProps) {
  const [copied, setCopied] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(branch);
      setCopied(true);
      setTooltipOpen(true);

      // Clear any existing timeout
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }

      // Close tooltip after showing "Copied!" for 1.5s
      closeTimeoutRef.current = setTimeout(() => {
        setCopied(false);
        setTooltipOpen(false);
      }, 1500);
    } catch (error) {
      console.error("Failed to copy branch name:", error);
    }
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-2.5">
        <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
          <TooltipTrigger asChild>
            <button
              onClick={handleCopy}
              onPointerEnter={() => !copied && setTooltipOpen(true)}
              onPointerLeave={() => !copied && setTooltipOpen(false)}
              className={`group hover:bg-accent hover:text-accent-foreground flex items-center rounded-lg transition-colors duration-200 ${
                compact ? "gap-1.5 px-2 py-1" : "-ml-2 gap-2 px-2 py-1"
              }`}
            >
              {copied ? (
                <Check
                  className={`text-success transition-colors duration-200 ${compact ? "h-3.5 w-3.5" : "h-4 w-4"}`}
                />
              ) : (
                <GitBranch
                  className={`transition-colors duration-200 ${compact ? "text-muted-foreground/70 h-3.5 w-3.5" : "text-muted-foreground h-4 w-4"} group-hover:text-foreground`}
                />
              )}
              <span
                className={`font-mono ${compact ? "text-muted-foreground/90 text-sm font-medium" : "text-base font-semibold"}`}
              >
                {branch}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">{copied ? "Copied!" : "Click to copy"}</p>
          </TooltipContent>
        </Tooltip>

        {!compact && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground bg-muted inline-flex cursor-default items-center rounded-lg px-2 py-1 text-xs font-medium">
                Isolated
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[240px]">
              <p className="text-xs">
                This is an isolated Git worktree. Safe to experiment. Changes won't affect your main
                branch.
              </p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
