import { X } from "lucide-react";

interface PastedImageCardProps {
  preview: string;
  fileName: string;
  onRemove: () => void;
}

export function PastedImageCard({ preview, fileName, onRemove }: PastedImageCardProps) {
  return (
    <div className="group bg-muted/50 border-border/60 animate-paste-card-enter relative h-[80px] w-[80px] shrink-0 overflow-hidden rounded-lg border">
      <img src={preview} className="h-full w-full object-cover" alt={fileName} />
      <button
        onClick={onRemove}
        className="bg-bg-elevated border-border/40 ease absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border opacity-0 shadow-sm transition-opacity duration-200 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label="Remove attachment"
      >
        <X className="text-muted-foreground h-3 w-3" />
      </button>
    </div>
  );
}
