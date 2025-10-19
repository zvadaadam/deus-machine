import { useState, useRef, useEffect } from "react";
import { GitBranch, Check } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface BranchNameProps {
  branch: string;
}

export function BranchName({ branch }: BranchNameProps) {
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
              className="flex items-center gap-2 group hover:bg-accent hover:text-accent-foreground rounded-md px-2 py-1 -ml-2 transition-colors duration-200"
            >
              {copied ? (
                <Check className="h-4 w-4 text-success transition-colors duration-200" />
              ) : (
                <GitBranch className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors duration-200" />
              )}
              <span className="text-base font-mono font-semibold">{branch}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">{copied ? "Copied!" : "Click to copy"}</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center px-2 py-1 text-xs font-medium text-muted-foreground bg-muted rounded-md cursor-default">
              Isolated
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[240px]">
            <p className="text-xs">This is an isolated Git worktree. Safe to experiment. Changes won't affect your main branch.</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
