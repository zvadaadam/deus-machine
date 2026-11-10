/**
 * Joins the static catalog with the pushed state into the views the Customize
 * page draws. Pure, so the backend's tests and the frontend agree on every
 * derived fact: readiness, which plugins include an item, whether a skill has
 * an update.
 */

import type {
  AppReadiness,
  AppState,
  AppView,
  Catalog,
  CatalogApp,
  ConnectionView,
  IntegrationsSnapshot,
  IntegrationsState,
  PluginView,
  SkillReadiness,
  SkillState,
  SkillView,
} from "./types";

function appReadiness(
  app: CatalogApp,
  state: AppState | undefined,
  available: boolean
): AppReadiness {
  if (!state) return "not_installed";
  if (!state.enabled) return "disabled";
  if (app.auth.kind === "none") return "ready";
  if (!available) return "unavailable";
  if (!state.connection) return "needs_connection";
  if (state.connection.status === "needs_reauth") return "needs_reauth";
  return state.connection.status === "active" ? "ready" : "needs_connection";
}

/**
 * Whether an installed app reaches cloud turns: one Deus Cloud holds an
 * account for, or a public remote server that needs none. An account held on
 * the person's computer does not (its token would sit in the platform's
 * queued turn and in a sandbox the agent controls), and neither does
 * anything that runs there.
 */
export function appReachesCloud(
  app: CatalogApp,
  connection: Pick<ConnectionView, "kind" | "status"> | null
): boolean {
  if (app.local || app.transport.type === "stdio") return false;
  if (connection?.kind === "managed") return connection.status === "active";
  return app.auth.kind === "none" && app.transport.type === "http";
}

function skillReadiness(state: SkillState | undefined): SkillReadiness {
  if (!state) return "not_installed";
  if (state.status === "installing") return "installing";
  if (state.status === "error") return "error";
  return state.enabled ? "ready" : "disabled";
}

export function composeSnapshot(catalog: Catalog, state: IntegrationsState): IntegrationsSnapshot {
  const appStates = new Map(state.apps.map((a) => [a.id, a]));
  const apps: AppView[] = [
    ...catalog.apps.map((app) => ({ app, source: "catalog" as const })),
    // The user's own server carries its definition; a catalog app does not.
    ...state.apps.flatMap((a) =>
      a.definition ? [{ app: a.definition, source: "custom" as const }] : []
    ),
  ].map(({ app, source }) => {
    const installed = appStates.get(app.id);
    const unavailable = state.unavailable[app.id] ?? null;
    const available = unavailable === null;
    return {
      app,
      source,
      installed: installed !== undefined,
      enabled: installed?.enabled ?? false,
      connection: installed?.connection ?? null,
      readiness: appReadiness(app, installed, available),
      available,
      unavailable,
      via: state.brokered[app.id] ?? null,
      cloud:
        state.cloudTurns &&
        available &&
        installed !== undefined &&
        installed.enabled &&
        appReachesCloud(app, installed.connection),
      toolCount: installed?.toolCount ?? null,
      checkError: installed?.checkError ?? null,
      checkedAt: installed?.checkedAt ?? null,
    };
  });

  const skillStates = new Map(state.skills.map((s) => [s.id, s]));
  const skills: SkillView[] = [
    ...catalog.skills.map((skill) => ({ skill, source: "catalog" as const })),
    ...state.skills.flatMap((s) =>
      s.definition ? [{ skill: s.definition, source: "custom" as const }] : []
    ),
  ].map(({ skill, source }) => {
    const installed = skillStates.get(skill.id);
    return {
      skill,
      source,
      installed: installed !== undefined,
      enabled: installed?.enabled ?? false,
      installedRef: installed?.installedRef ?? null,
      updateAvailable:
        source === "catalog" &&
        installed?.status === "ready" &&
        installed.installedRef !== null &&
        installed.installedRef !== skill.source.ref,
      readiness: skillReadiness(installed),
      error: installed?.error ?? null,
    };
  });

  const readinessOf = new Map(apps.map((view) => [view.app.id, view.readiness]));
  const plugins: PluginView[] = catalog.plugins.map((plugin) => ({
    plugin,
    installed: state.plugins.includes(plugin.id),
    appsNeedingConnection: plugin.apps.filter((id) => {
      const readiness = readinessOf.get(id);
      return readiness === "needs_connection" || readiness === "needs_reauth";
    }),
  }));

  return { apps, skills, plugins };
}
