import { useMemo } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/shared/lib/utils";
import { getCleanRepoName } from "../lib/utils";

interface RepoAvatarProps {
  repoName: string;
  className?: string;
}

/**
 * RepoAvatar — V2: Jony Ive
 *
 * 20×20 square badge with 6px radius (matches design token radius-md).
 * Falls back to a single letter on a dark, subtly tinted background.
 * The tint is derived from a stable hue hash of the repo name —
 * just enough color to distinguish, never enough to distract.
 */
export function RepoAvatar({ repoName, className }: RepoAvatarProps) {
  const { displayName, initial, avatarUrl, fallbackBg, fallbackText } = useMemo(() => {
    const parts = repoName.split("/");
    const owner = parts.length === 2 ? parts[0] : null;
    const display = getCleanRepoName(repoName);

    // Deterministic hue from name hash
    const hue = repoName.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;

    return {
      displayName: display,
      initial: display.slice(0, 1).toUpperCase(),
      avatarUrl: owner ? `https://avatars.githubusercontent.com/${owner}?size=40` : null,
      // Subtle tinted dark bg — barely there, just enough to distinguish
      fallbackBg: `oklch(0.18 0.03 ${hue})`,
      fallbackText: `oklch(0.55 0.04 ${hue})`,
    };
  }, [repoName]);

  return (
    <Avatar shape="square" className={cn("h-5 w-5 rounded-md", className)}>
      {avatarUrl && (
        <AvatarImage src={avatarUrl} alt={`${displayName} avatar`} className="rounded-md" />
      )}
      <AvatarFallback
        shape="square"
        className="rounded-md text-[10px] font-semibold"
        style={{ backgroundColor: fallbackBg, color: fallbackText }}
        delayMs={0}
      >
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}
