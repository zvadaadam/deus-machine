import { useState } from "react";
import { useWindowOrganization } from "@/features/sidebar/hooks/useWindowOrganization";
import { sectionOrganization } from "../lib/section-organization";

/**
 * A Settings section's organization select: what it shows (`sectionOrganization`:
 * the section's own choice, else the window's organization, else the first listed)
 * and how the section chooses. Choosing here never moves the window.
 */
export function useSectionOrganization(items: readonly { id: string }[] | undefined) {
  const [selected, select] = useState<string | null>(null);
  const windowOrganization = useWindowOrganization().id;
  return [sectionOrganization(selected, windowOrganization, items), select] as const;
}
