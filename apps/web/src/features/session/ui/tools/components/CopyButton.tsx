/**
 * Copy Button Component
 *
 * Reusable button for copying text to clipboard with visual feedback
 */

import { CopyIcon } from "@/components/ui/copy-icon";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { cn } from "@/shared/lib/utils";

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
  size?: "sm" | "md";
}

export function CopyButton({ text, label = "Copy", className, size = "sm" }: CopyButtonProps) {
  const { copy, copied } = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void copy(text);
      }}
      className={cn(
        "control-interaction inline-flex items-center gap-1.5 rounded-lg",
        "hover:bg-control-hover active:bg-control-pressed bg-transparent",
        "text-muted-foreground hover:text-foreground",
        "border-border/40 hover:border-border border",
        "disabled:cursor-not-allowed",
        "text-sm",
        size === "sm" ? "h-6 px-2" : "h-8 px-3",
        className
      )}
      title={copied ? "Copied!" : label}
      aria-label={copied ? "Copied!" : label}
    >
      <CopyIcon
        copied={copied}
        className={cn(size === "sm" ? "size-3" : "size-4", copied && "text-success")}
      />
      <span aria-hidden="true" className="inline-grid [&>span]:[grid-area:1/1]">
        <span className={cn(copied && "invisible")}>{label}</span>
        <span className={cn("text-success font-medium", !copied && "invisible")}>Copied</span>
      </span>
    </button>
  );
}
