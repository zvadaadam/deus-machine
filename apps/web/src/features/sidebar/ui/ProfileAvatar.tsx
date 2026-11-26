import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initialsFrom } from "@/shared/lib/formatters";
import { cn } from "@/shared/lib/utils";
import type { SidebarProfile } from "../model/types";

export function profileName(profile?: SidebarProfile) {
  return profile?.displayName || profile?.login || "My Account";
}

export function ProfileAvatar({
  profile,
  label,
  className,
  shape = "square",
}: {
  profile?: SidebarProfile;
  label?: string;
  className?: string;
  shape?: "square" | "circle";
}) {
  const name = profileName(profile);
  return (
    <Avatar shape={shape} className={cn("size-6", shape === "square" && "rounded-md", className)}>
      {profile?.avatarUrl && <AvatarImage src={profile.avatarUrl} alt={label ?? name} />}
      <AvatarFallback shape="square" className="text-2xs rounded-[inherit] font-semibold">
        {initialsFrom(name)}
      </AvatarFallback>
      {profile?.avatarUrl && (
        <span
          aria-hidden
          className="ring-foreground/10 pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset"
        />
      )}
    </Avatar>
  );
}
