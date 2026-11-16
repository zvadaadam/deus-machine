/**
 * Where a new workspace runs, for the prompt-first composer. It starts from the
 * window's place (the cloud only when the window's organization is ready, or, with
 * no list, when the cloud is available) and follows it while mounted; the Cloud
 * control and its access gate own every change after that. Its organization is its
 * own too: it starts as the window's and follows it, and a choice made in the
 * composer's menu stays in the composer. Nothing here writes the sidebar store.
 */
import { useState } from "react";
import { useSidebarStore } from "@/features/sidebar/store";
import {
  chosenOrganization,
  composerOrganization,
  composerPlace,
  composerSwitch,
  followWindowOrganization,
  visiblePlace,
  type ComposerOrganization,
  type WorkspaceLocation,
} from "@/features/sidebar/lib/location";
import { useCloudOrganizations } from "@/shared/hooks/useCloudOrganizations";

export function useComposerLocation() {
  const storedLocation = useSidebarStore((s) => s.location);
  const storedOrganization = useSidebarStore((s) => s.cloudOrganizationId);
  const organizations = useCloudOrganizations();
  // The window's place as the sidebar shows it; Home has no selected workspace.
  const windowPlace = visiblePlace(
    { location: storedLocation, organizationId: storedOrganization },
    organizations,
    null
  );
  const preferredLocation = composerPlace(windowPlace, organizations).location;

  const [location, setLocation] = useState<WorkspaceLocation>(preferredLocation);
  // Follow the preference when it changes (adjusted during render, not in an effect).
  const [appliedLocation, setAppliedLocation] = useState(preferredLocation);
  if (appliedLocation !== preferredLocation) {
    setAppliedLocation(preferredLocation);
    setLocation(preferredLocation);
  }

  // The window's organization, wherever the window is; the composer's follows it.
  const windowOrganizationId = chosenOrganization(storedOrganization, organizations);
  const [own, setOwn] = useState<ComposerOrganization>({
    windowOrganizationId,
    choice: null,
  });
  const followed = followWindowOrganization(own, windowOrganizationId);
  if (followed !== own) setOwn(followed);
  const organizationId = composerOrganization(followed, organizations);
  const organization = organizationId
    ? (organizations?.items.find((org) => org.id === organizationId) ?? null)
    : null;
  const setOrganization = (id: string) => setOwn((state) => ({ ...state, choice: id }));
  const cloudReady = organizations
    ? organization
      ? organization.ready
      : organizations.available
    : undefined;

  // On only where a create would be accepted: an organization not ready turns it off.
  const accepted = composerSwitch(location, cloudReady);
  if (accepted !== location) setLocation(accepted);

  return {
    location: accepted,
    setLocation,
    preferredLocation,
    /** The organization a cloud workspace starts in; null with no list. */
    organization,
    /** Choose the composer's organization (the composer's menu); the sidebar stays. */
    setOrganization,
    /** The account's organizations, in the list's order; empty with no list. */
    organizations: organizations?.items ?? [],
    /** The control can choose the cloud: that organization is ready (or, with no list,
     *  the cloud is available); undefined until the backend's value arrives. */
    cloudReady,
  };
}
