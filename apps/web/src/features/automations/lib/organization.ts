/**
 * Which automations the page shows: the window's organization's. A row with no
 * organization (kept from before organizations were recorded) is the default
 * organization's, and one in an organization the list does not name is shown in
 * the default one, as the sidebar does with workspaces. With no list (one
 * nameless cloud), every automation.
 */
import { chosenOrganization, type Organizations } from "@/features/sidebar/lib/location";
import type { Automation } from "@/shared/types";

/** A new automation's input, created in `organizationId` (with none, the default one). */
export function inOrganization<T extends object>(
  input: T,
  organizationId: string | null
): T & { organization_id?: string } {
  return organizationId ? { ...input, organization_id: organizationId } : input;
}

export function automationsInOrganization(
  automations: readonly Automation[],
  organizations: Organizations,
  organizationId: string | null
): Automation[] {
  if (!organizationId || !organizations?.items.length) return [...automations];
  return automations.filter(
    (automation) =>
      chosenOrganization(
        automation.organization_id ?? organizations.defaultOrganizationId,
        organizations
      ) === organizationId
  );
}
