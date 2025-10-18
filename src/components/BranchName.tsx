import { useState } from "react";
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

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(branch);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy branch name:", error);
    }
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCopy}
            className="flex items-center gap-2 group hover:bg-accent hover:text-accent-foreground rounded-md px-2 py-1 -ml-2 transition-colors duration-200"
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-500 transition-all duration-200" />
            ) : (
              <GitBranch className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors duration-200" />
            )}
            <span className="text-base font-medium">{branch}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{copied ? "Copied!" : "Click to copy"}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
