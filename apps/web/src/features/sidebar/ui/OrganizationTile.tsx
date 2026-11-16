import { cn } from "@/shared/lib/utils";

/** An organization: its initial, on the cloud glyph's tile (the header menu, the composer's). */
export function OrganizationTile({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "bg-muted text-text-secondary text-2xs flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-semibold",
        className
      )}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
