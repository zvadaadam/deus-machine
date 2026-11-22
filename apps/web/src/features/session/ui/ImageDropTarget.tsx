import { useState, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { isUnclaimedFileDrag } from "../lib/imageAttachments";
import { attachImageFiles } from "../store/sessionComposerStore";

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
        const unclaimed = isUnclaimedFileDrag(event);
        setOver(unclaimed && !disabled);
        if (!unclaimed) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOver(false);
      }}
      onDrop={async (event) => {
        setOver(false);
        if (!isUnclaimedFileDrag(event)) return;
        event.preventDefault();
        if (disabled) return;
        await attachImageFiles(composerId, Array.from(event.dataTransfer.files));
      }}
    >
      {children}
      {/* The overlay ignores pointer events so the browser keeps hit-testing the drop surface underneath. */}
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
