/**
 * Where a new workspace runs, for the two prompt-first composers. It starts from
 * the window's location (cloud only when this backend is signed in to Deus
 * Cloud) and follows it while mounted; the Cloud toggle and its access gate own
 * every change after that.
 */
import { useState } from "react";
import { useSidebarStore } from "@/features/sidebar/store";
import { composerLocation, type WorkspaceLocation } from "@/features/sidebar/lib/location";
import { useCloudSettings } from "@/shared/hooks/useCloudSettings";

/** `enabled`: ask for the cloud status only where the Cloud toggle shows (it asks the same). */
export function useComposerLocation({ enabled }: { enabled: boolean }) {
  const windowLocation = useSidebarStore((s) => s.location);
  const cloudStatus = useCloudSettings({ enabled });
  const preferredLocation = composerLocation(windowLocation, !!cloudStatus.data?.enabled);

  const [location, setLocation] = useState<WorkspaceLocation>(preferredLocation);
  // Follow the preference when it changes (adjusted during render, not in an effect).
  const [appliedLocation, setAppliedLocation] = useState(preferredLocation);
  if (appliedLocation !== preferredLocation) {
    setAppliedLocation(preferredLocation);
    setLocation(preferredLocation);
  }

  return { location, setLocation, preferredLocation };
}
