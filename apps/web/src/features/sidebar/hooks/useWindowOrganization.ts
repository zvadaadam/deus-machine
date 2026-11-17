/**
 * The window's organization, for pages outside the sidebar (Settings, automations):
 * the one last chosen in the header menu if the list names it, else the default,
 * else the first listed; none with no list. It is the window's organization
 * whatever its location (this computer or the cloud).
 */
import { useSidebarStore } from "@/features/sidebar/store";
import { chosenOrganization } from "@/features/sidebar/lib/location";
import { useCloudOrganizations } from "@/shared/hooks/useCloudOrganizations";

export function useWindowOrganization() {
  const stored = useSidebarStore((s) => s.cloudOrganizationId);
  const organizations = useCloudOrganizations();
  const id = chosenOrganization(stored, organizations);
  return {
    /** The organization's id; null with no list. */
    id,
    organization: id ? (organizations?.items.find((org) => org.id === id) ?? null) : null,
    /** The backend's value; undefined until it arrives. */
    organizations,
    /** The account has more than one organization: a page names the one it shows. */
    several: (organizations?.items.length ?? 0) > 1,
  };
}
