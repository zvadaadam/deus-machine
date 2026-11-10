// backend/src/services/integrations/state.ts
// What clients read. The catalog is static for a build, so it is served once
// (`integrationsCatalog`); what is installed and connected is pushed
// (`integrations`) and carries only that. Neither ever carries a credential.

import { CATALOG } from "@shared/integrations/catalog";
import {
  CatalogAppSchema,
  CatalogSkillSchema,
  type AppState,
  type Catalog,
  type IntegrationsState,
  type SkillInstallStatus,
  type SkillState,
} from "@shared/integrations/types";
import { cloudExtensionsEnabled } from "./cloud-turns";
import { signInRoute } from "./sign-in-route";
import { listConnections, listInstallations, toConnectionView } from "./store";

export function getCatalog(): Catalog {
  return CATALOG;
}

function skillStatus(status: string | null): SkillInstallStatus {
  return status === "ready" || status === "error" ? status : "installing";
}

export function getState(): IntegrationsState {
  const installs = listInstallations();
  const connections = new Map(listConnections().map((c) => [c.id, c]));

  const apps: AppState[] = installs.flatMap((row) => {
    if (row.kind !== "app") return [];
    const definition =
      row.source === "custom" ? CatalogAppSchema.safeParse(row.definition).data : undefined;
    if (row.source === "custom" && !definition) return [];
    const connection = row.connectionId ? connections.get(row.connectionId) : undefined;
    return [
      {
        id: row.itemId,
        ...(definition ? { definition } : {}),
        enabled: row.enabled,
        connection: connection ? toConnectionView(connection) : null,
        toolCount: row.toolCount,
        checkError: row.error,
        checkedAt: row.checkedAt,
      },
    ];
  });

  const skills: SkillState[] = installs.flatMap((row) => {
    if (row.kind !== "skill") return [];
    const definition =
      row.source === "custom" ? CatalogSkillSchema.safeParse(row.definition).data : undefined;
    if (row.source === "custom" && !definition) return [];
    return [
      {
        id: row.itemId,
        ...(definition ? { definition } : {}),
        enabled: row.enabled,
        installedRef: row.installedRef,
        status: skillStatus(row.status),
        error: row.error,
      },
    ];
  });

  const brokered: IntegrationsState["brokered"] = {};
  const unavailable: IntegrationsState["unavailable"] = {};
  for (const app of CATALOG.apps) {
    const route = signInRoute(app);
    if (route.via === "cloud") brokered[app.id] = route.label;
    else if (route.via === "unavailable") unavailable[app.id] = route.reason;
  }

  return {
    catalogVersion: CATALOG.version,
    apps,
    skills,
    plugins: installs.filter((row) => row.kind === "plugin").map((row) => row.itemId),
    unavailable,
    brokered,
    cloudTurns: cloudExtensionsEnabled(),
  };
}
