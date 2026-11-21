import { useState, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { attachImageFiles } from "../store/sessionComposerStore";

/** One drop surface for Home, the workspace start page and the whole chat panel.
 * The overlay is decoration: Chromium must keep hit-testing the original target. */
export function ImageDropTarget({
  composerId,
  disabled,
  className,
  children,
}: {
  composerId: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cn("relative", className)}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? "none" : "copy";
        setOver(!disabled);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={async (event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setOver(false);
        if (disabled) return;
        await attachImageFiles(composerId, Array.from(event.dataTransfer.files));
      }}
    >
      {children}
      {over && (
        <div
          aria-hidden="true"
          className="bg-bg-overlay/80 text-text-primary pointer-events-none absolute inset-0 z-50 flex items-center justify-center gap-2 rounded-[inherit] backdrop-blur-sm"
        >
          <Upload className="size-4" />
          <span className="text-sm font-medium">Drop images here</span>
        </div>
      )}
    </div>
  );
}
