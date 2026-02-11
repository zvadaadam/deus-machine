import { useMemo } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/shared/lib/utils";
import { getCleanRepoName } from "../lib/utils";

interface RepoAvatarProps {
  repoName: string;
  className?: string;
}

/**
 * RepoAvatar — 20×20 square badge with 6px radius.
 *
 * Uses theme-aware bg-muted / text-tertiary so it adapts to light and dark modes.
 * GitHub org avatar shown when the repo name includes an owner prefix.
 */
export function RepoAvatar({ repoName, className }: RepoAvatarProps) {
  const { displayName, initial, avatarUrl } = useMemo(() => {
    const parts = repoName.split("/");
    const owner = parts.length === 2 ? parts[0] : null;
    const display = getCleanRepoName(repoName);

    return {
      displayName: display,
      initial: display.slice(0, 1).toUpperCase(),
      avatarUrl: owner ? `https://avatars.githubusercontent.com/${owner}?size=40` : null,
    };
  }, [repoName]);

  return (
    <Avatar shape="square" className={cn("h-5 w-5 rounded-md", className)}>
      {avatarUrl && (
        <AvatarImage src={avatarUrl} alt={`${displayName} avatar`} className="rounded-md" />
      )}
      <AvatarFallback
        shape="square"
        className="bg-bg-muted text-text-tertiary rounded-md text-[10px] font-semibold"
        delayMs={0}
      >
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}
