import type { Board, BoardPost } from "@shared/boards";
import { Network } from "lucide-react";
import { ProfileAvatar } from "@/features/sidebar/ui/ProfileAvatar";
import type { SidebarProfile } from "@/features/sidebar/model/types";
import { cn } from "@/shared/lib/utils";

export function BoardAvatar({
  kind,
  profile,
  className,
}: {
  kind: BoardPost["author_kind"];
  board: Board;
  profile?: SidebarProfile;
  className?: string;
}) {
  if (kind === "person")
    return <ProfileAvatar profile={profile} shape="circle" className={cn("size-8", className)} />;
  return (
    <span
      data-board-avatar={kind}
      aria-hidden
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-[20%]",
        "bg-muted text-muted-foreground",
        className
      )}
    >
      <Network className="size-3/5" />
    </span>
  );
}
