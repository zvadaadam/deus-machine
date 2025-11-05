/**
 * Copy Button Component
 *
 * Reusable button for copying text to clipboard with visual feedback
 */

import { useState, useEffect, useRef } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/shared/lib/utils";

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
  size?: "sm" | "md";
}

export function CopyButton({ text, label = "Copy", className, size = "sm" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger parent clicks

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);

      // Clear existing timer if any
      if (timerRef.current) clearTimeout(timerRef.current);

      // Set new timer
      timerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const sizeClasses = {
    sm: "h-6 px-2 text-xs",
    md: "h-8 px-3 text-sm",
  };

  const iconSize = {
    sm: "w-3 h-3",
    md: "w-4 h-4",
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-1.5 rounded transition-colors duration-200",
        "hover:bg-muted/50 bg-transparent",
        "text-muted-foreground hover:text-foreground",
        "border-border/40 hover:border-border border",
        "disabled:cursor-not-allowed disabled:opacity-50",
        sizeClasses[size],
        className
      )}
      title={copied ? "Copied!" : label}
      aria-label={copied ? "Copied!" : label}
    >
      {copied ? (
        <>
          <Check className={cn(iconSize[size], "text-success")} aria-hidden="true" />
          <span className="text-success font-medium">Copied</span>
        </>
      ) : (
        <>
          <Copy className={iconSize[size]} aria-hidden="true" />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}
