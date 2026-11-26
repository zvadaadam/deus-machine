import type { Board, BoardPost } from "@shared/boards";
import { Blocks, Compass, Layers3, Orbit } from "lucide-react";
import { ProfileAvatar } from "@/features/sidebar/ui/ProfileAvatar";
import type { SidebarProfile } from "@/features/sidebar/model/types";
import { cn } from "@/shared/lib/utils";

const glyphs = [Blocks, Compass, Layers3, Orbit] as const;
const tints = [
  "bg-accent-blue/12 text-accent-blue",
  "bg-accent-gold/12 text-accent-gold",
  "bg-success/12 text-success",
  "bg-primary/12 text-primary",
] as const;

function boardMark(id: string) {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return { Glyph: glyphs[hash % glyphs.length]!, tint: tints[(hash >>> 8) % tints.length]! };
}

export function BoardAvatar({
  kind,
  board,
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
  const { Glyph, tint } = boardMark(board.id);
  return (
    <span
      data-board-avatar={kind}
      aria-hidden
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-[20%]",
        tint,
        className
      )}
    >
      <Glyph className="size-3/5" />
    </span>
  );
}
