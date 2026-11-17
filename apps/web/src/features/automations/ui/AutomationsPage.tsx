/**
 * AutomationsPage — the full-page Automations view (design boards 46a–46c).
 *
 * Cloud-only: the agnt platform schedules and executes automations; deus
 * mirrors them. The page shows the window's organization's automations and
 * creates in it; it re-mirrors that organization on mount and on window focus,
 * and gates on the organization being ready on this computer. Three modes in
 * one surface: the list, and two split modes (rail + panel) for the editor and
 * the detail. The app sidebar stays; this fills the main inset like Home does.
 */

import { useEffect, useState } from "react";
import { Cloud } from "lucide-react";
import { SidebarInset, SidebarMobileBar } from "@/components/ui/sidebar";
import { Button } from "@/components/ui";
import { useWindowOrganization } from "@/features/sidebar/hooks/useWindowOrganization";
import { useUIStore } from "@/shared/stores/uiStore";
import { openNewWorkspace } from "@/features/workspace/lib/newWorkspace";
import type { Automation } from "@/shared/types";
import { refreshAutomations, useAutomations } from "../api/automations.queries";
import { automationsInOrganization } from "../lib/organization";
import { AutomationsListView } from "./AutomationsListView";
import { AutomationRail } from "./AutomationRail";
import { AutomationEditor, type EditorPrefill } from "./AutomationEditor";
import { AutomationDetail } from "./AutomationDetail";
import { TemplatesView } from "./TemplatesView";

type ViewState =
  | { mode: "list" }
  | { mode: "templates" }
  | { mode: "editor"; automationId: string | null; prefill?: EditorPrefill }
  | { mode: "detail"; automationId: string };

export function AutomationsPage() {
  // Deep-link from a provenance chip: the initializer covers the fresh-mount
  // case without a render cascade, and the subscription covers chips clicked
  // WHILE this page is already open (hover cards render beside it) — the
  // store value only changes when a chip fires, and consuming it clears it.
  const [view, setView] = useState<ViewState>(() => {
    const focusId = useUIStore.getState().automationsFocusId;
    return focusId ? { mode: "detail", automationId: focusId } : { mode: "list" };
  });
  const focusId = useUIStore((s) => s.automationsFocusId);
  useEffect(() => {
    if (!focusId) return;
    setView({ mode: "detail", automationId: focusId });
    useUIStore.getState().clearAutomationsFocus();
  }, [focusId]);
  const { data: allAutomations, isLoading } = useAutomations();
  const windowOrganization = useWindowOrganization();
  const organizationId = windowOrganization.id;
  const { organizations } = windowOrganization;
  // The window's organization's automations (every one with no list).
  const automations = allAutomations
    ? automationsInOrganization(allAutomations, organizations, organizationId)
    : undefined;

  // Cloud gate — automations live on the platform: the window's organization is
  // ready on this computer (with no list, the cloud is available).
  const cloudKnown = organizations !== undefined;
  const cloudReady = windowOrganization.organization
    ? windowOrganization.organization.ready
    : organizations?.available === true;

  // Mirror the window's organization on mount, when it changes, and whenever the
  // window regains focus.
  useEffect(() => {
    if (!cloudReady) return;
    refreshAutomations(undefined, organizationId);
    const onFocus = () => refreshAutomations(undefined, organizationId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [cloudReady, organizationId]);

  const openList = () => setView({ mode: "list" });
  const openTemplates = () => setView({ mode: "templates" });
  const openNew = (prefill?: EditorPrefill) =>
    setView({ mode: "editor", automationId: null, prefill });
  const createWithAi = () =>
    openNewWorkspace({ draft: "Create a scheduled automation for this repo. It should: " });
  const openDetail = (automation: Automation) =>
    setView({ mode: "detail", automationId: automation.id });
  const openEdit = (automationId: string) => setView({ mode: "editor", automationId });

  const selectedId = view.mode === "editor" || view.mode === "detail" ? view.automationId : null;
  // From every automation, so a provenance chip still opens one of another organization.
  const selected =
    selectedId != null ? ((allAutomations ?? []).find((a) => a.id === selectedId) ?? null) : null;

  // A detail whose automation vanished (deleted here or elsewhere) returns to
  // the list — render-time adjustment, guarded so a still-loading cache
  // doesn't bounce the view.
  if (view.mode === "detail" && allAutomations !== undefined && !selected) {
    setView({ mode: "list" });
  }

  return (
    <SidebarInset className="min-w-0">
      <div className="bg-bg-surface border-border-subtle flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-xl border">
        <SidebarMobileBar title="Automations" />
        <div className="flex min-h-0 min-w-0 flex-1">
          {cloudKnown && !cloudReady ? (
            <CloudNudge />
          ) : view.mode === "list" ? (
            <AutomationsListView
              automations={automations ?? []}
              isLoading={isLoading}
              onNew={openNew}
              onCreateWithAi={createWithAi}
              onOpenTemplates={openTemplates}
              onOpen={openDetail}
              organizationName={
                windowOrganization.several ? (windowOrganization.organization?.name ?? null) : null
              }
            />
          ) : view.mode === "templates" ? (
            <TemplatesView onBack={openList} onUse={(prefill) => openNew(prefill)} />
          ) : (
            <>
              <AutomationRail
                automations={automations ?? []}
                selectedId={selectedId}
                onSelect={(a) => openDetail(a)}
                onNew={() => openNew()}
                onBack={openList}
              />
              {view.mode === "editor" ? (
                <AutomationEditor
                  key={view.automationId ?? "new"}
                  automation={selected}
                  prefill={view.prefill}
                  organizationId={organizationId}
                  onBack={openList}
                  onSaved={(a) => setView({ mode: "detail", automationId: a.id })}
                />
              ) : selected ? (
                <AutomationDetail
                  automation={selected}
                  onBack={openList}
                  onEdit={() => openEdit(selected.id)}
                />
              ) : (
                // One frame while the render-time adjustment above lands.
                <div className="flex-1" />
              )}
            </>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

/** Automations need Deus Cloud — same empty-state anatomy as the list's. */
function CloudNudge() {
  const openSettings = useUIStore((s) => s.openSettings);
  const setSection = useUIStore((s) => s.setActiveSettingsSection);
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex max-w-sm flex-col items-center gap-2.5 text-center">
        <div className="bg-bg-elevated flex h-9 w-9 items-center justify-center rounded-md">
          <Cloud className="text-text-secondary h-4 w-4" />
        </div>
        <span className="text-text-primary text-sm font-medium">Automations run in Deus Cloud</span>
        <span className="text-text-tertiary text-xs leading-relaxed">
          They fire on schedule in cloud sandboxes — even when this Mac is closed. Sign in to Deus
          Cloud to create one.
        </span>
        <Button
          variant="outline"
          size="sm"
          className="mt-1.5"
          onClick={() => {
            setSection("cloud");
            openSettings();
          }}
        >
          Open Settings → Cloud
        </Button>
      </div>
    </div>
  );
}
