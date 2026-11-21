import { Check, Copy, type LucideIcon } from "lucide-react";
import { cn } from "@/shared/lib/utils";

function glyph(visible: boolean) {
  return cn(
    "col-start-1 row-start-1 size-full transition-[opacity,scale,filter]",
    !visible && "tempo-fast-exit opacity-0 motion-safe:scale-60 motion-safe:blur-[4px]"
  );
}

export function CopyIcon({
  copied,
  icon: Icon = Copy,
  className,
}: {
  copied: boolean;
  icon?: LucideIcon;
  className: string;
}) {
  return (
    <span data-slot="copy-icon" className={cn("grid shrink-0", className)}>
      <Icon aria-hidden="true" className={glyph(!copied)} />
      <Check aria-hidden="true" className={glyph(copied)} />
      <span role="status" className="sr-only">
        {copied && "Copied"}
      </span>
    </span>
  );
}
