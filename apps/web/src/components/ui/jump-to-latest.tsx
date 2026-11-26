import { ChevronDown } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/shared/lib/utils";

export function JumpToLatest({
  visible,
  onClick,
  controls,
}: {
  visible: boolean;
  onClick: () => void;
  controls: string;
}) {
  return (
    <div
      {...(!visible && { inert: "" })}
      className={cn(
        "absolute right-6 bottom-4 z-10 transition-[opacity,scale]",
        visible
          ? "scale-100 opacity-100"
          : "pointer-events-none scale-90 opacity-0 motion-reduce:scale-100"
      )}
    >
      <Button
        variant="secondary"
        size="icon"
        className="rounded-full shadow-lg transition-shadow hover:shadow-xl"
        onClick={onClick}
        aria-controls={controls}
        title="Scroll to bottom"
        aria-label="Scroll to bottom"
      >
        <ChevronDown className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
