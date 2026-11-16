import type { CloudOrganizations } from "@shared/types/environment-secrets";

/**
 * The organization a Settings section with its own organization select shows: the
 * one chosen in the section, if its list names it; else the window's, if its list
 * names it; else its first. A choice made in a section stays that section's.
 */
export function sectionOrganization(
  selected: string | null,
  windowOrganization: string | null,
  items: readonly { id: string }[] | undefined
): string | null {
  const listed = (id: string | null) => !!id && !!items?.some((org) => org.id === id);
  if (listed(selected)) return selected;
  if (listed(windowOrganization)) return windowOrganization;
  return items?.[0]?.id ?? null;
}

/**
 * Why a cloud setup workspace cannot start in this organization on this computer:
 * it is not ready here (no key for it yet), or, with no list, the cloud is not.
 */
export function cloudNotReady(
  organizations: CloudOrganizations | undefined,
  organizationId: string | null
): string | null {
  if (!organizations) return "Checking this computer’s cloud setup…";
  const organization = organizationId
    ? organizations.items.find((org) => org.id === organizationId)
    : undefined;
  if (organization) {
    return organization.ready
      ? null
      : `${organization.name} is not set up on this computer yet. Finish device setup in Settings → Cloud.`;
  }
  if (organizations.items.length > 0)
    return "This organization is not set up on this computer. Finish device setup in Settings → Cloud.";
  return organizations.available ? null : "Finish device setup in Settings → Cloud.";
}
