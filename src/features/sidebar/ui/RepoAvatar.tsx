import { useMemo } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useTheme } from "@/app/providers";
import { cn } from "@/shared/lib/utils";
import { getCleanRepoName } from "../lib/utils";

interface RepoAvatarProps {
  repoName: string;
  className?: string;
}

/**
 * Self-contained repo badge that tries a GitHub owner avatar
 * and falls back to a desaturated letter badge.
 *
 * Avatar URL: https://avatars.githubusercontent.com/{owner}?size=40
 * No auth needed — works for any public GitHub user/org.
 * Radix Avatar handles 404 / slow-load gracefully.
 */
export function RepoAvatar({ repoName, className }: RepoAvatarProps) {
  const { actualTheme } = useTheme();

  const { displayName, initial, avatarUrl, fallbackBg, fallbackText } = useMemo(() => {
    const parts = repoName.split("/");
    const owner = parts.length === 2 ? parts[0] : null;
    const display = getCleanRepoName(repoName);

    // Deterministic hue from name hash (full 0-360 range)
    const hue = repoName.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
    const isDark = actualTheme === "dark";

    return {
      displayName: display,
      initial: display.slice(0, 1).toUpperCase(),
      avatarUrl: owner ? `https://avatars.githubusercontent.com/${owner}?size=40` : null,
      fallbackBg: isDark ? `oklch(0.25 0.04 ${hue})` : `oklch(0.92 0.04 ${hue})`,
      fallbackText: isDark ? `oklch(0.72 0.06 ${hue})` : `oklch(0.45 0.06 ${hue})`,
    };
  }, [repoName, actualTheme]);

  return (
    <Avatar shape="square" className={cn("h-5 w-5 rounded-[4px]", className)}>
      {avatarUrl && (
        <AvatarImage src={avatarUrl} alt={`${displayName} avatar`} className="rounded-[4px]" />
      )}
      <AvatarFallback
        shape="square"
        className="rounded-[4px] text-[11px] font-semibold"
        style={{ backgroundColor: fallbackBg, color: fallbackText }}
        delayMs={0}
      >
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}
