/**
 * CustomizePage — Apps, Recommended Plugins and Skills (design boards 48a
 * and 48f).
 *
 * Three views over one install system. Apps connect a service or local tool
 * (Connect → sign in or paste a key); plugins install a curated bundle of
 * apps and skills (Install → connect its apps when they are needed); skills
 * add a workflow the agent can follow (Add). Everything installed here
 * reaches every agent, Claude and Codex, in every project.
 *
 * Opening an item replaces the catalog with its page (48b–48e) instead of a
 * dialog; the catalog stays mounted underneath, so going back keeps the
 * search, tab and scroll position. The app sidebar stays; the page fills
 * the main inset like Automations does.
 */

import { useMemo, useState, type ReactNode } from "react";
import { BookOpen, Check, Loader2, Package, Plus, Search, Server } from "lucide-react";
import { SidebarInset, SidebarMobileBar } from "@/components/ui/sidebar";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ScrollArea,
} from "@/components/ui";
import { cn } from "@/shared/lib/utils";
import { getErrorMessage } from "@shared/lib/errors";
import {
  INTEGRATION_CATEGORY_LABELS,
  type AppView,
  type IntegrationCategory,
  type PluginView,
  type SkillView,
} from "@shared/integrations/types";
import { useIntegrations, useInstall, useLocalSkills } from "../api/integrations.queries";
import { appStatus, pluginStatus, skillStatus, TONE_CLASS, type StatusLabel } from "../lib/status";
import { useConnectFlow } from "../lib/useConnectFlow";
import { ItemIcon, PluginIcon } from "./ItemIcon";
import { AppDetail } from "./AppDetail";
import { PluginDetail } from "./PluginDetail";
import { SkillDetail } from "./SkillDetail";
import { AddCustomDialog, type AddCustomMode } from "./AddCustomDialog";
import type { Crumb } from "./DetailPage";

type Tab = "apps" | "plugins" | "skills";
type Selection = { kind: "app" | "plugin" | "skill"; id: string } | null;

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "apps", label: "Apps" },
  { id: "plugins", label: "Recommended Plugins" },
  { id: "skills", label: "Skills" },
];

const CATEGORY_ORDER: IntegrationCategory[] = [
  "developer",
  "design",
  "creative",
  "marketing",
  "productivity",
  "data",
  "commerce",
  "communication",
  "writing",
  "documents",
];

export function CustomizePage() {
  const { data, isLoading, error } = useIntegrations();
  const [tab, setTab] = useState<Tab>("apps");
  const [query, setQuery] = useState("");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [addMode, setAddMode] = useState<AddCustomMode | null>(null);

  const localSkills = useLocalSkills(tab === "skills");
  const needle = query.trim().toLowerCase();
  const apps = useMemo(
    () =>
      filterItems(data?.apps, needle, installedOnly, (v) => [
        v.app.name,
        v.app.description,
        v.app.publisher,
        ...v.app.categories,
      ]),
    [data?.apps, needle, installedOnly]
  );
  const plugins = useMemo(
    () =>
      filterItems(data?.plugins, needle, installedOnly, (v) => [
        v.plugin.title,
        v.plugin.tagline,
        v.plugin.description,
      ]),
    [data?.plugins, needle, installedOnly]
  );
  const skills = useMemo(
    () =>
      filterItems(data?.skills, needle, installedOnly, (v) => [
        v.skill.title,
        v.skill.name,
        v.skill.description,
        v.skill.publisher,
      ]),
    [data?.skills, needle, installedOnly]
  );

  const appIcons = useMemo(
    () => new Map((data?.apps ?? []).map((v) => [v.app.id, v.app.icon])),
    [data?.apps]
  );

  const counts: Record<Tab, number> = {
    apps: (data?.apps ?? []).filter((v) => v.installed).length,
    plugins: (data?.plugins ?? []).filter((v) => v.installed).length,
    skills: (data?.skills ?? []).filter((v) => v.installed).length,
  };

  const selectedApp =
    selection?.kind === "app" ? data?.apps.find((v) => v.app.id === selection.id) : undefined;
  const selectedPlugin =
    selection?.kind === "plugin"
      ? data?.plugins.find((v) => v.plugin.id === selection.id)
      : undefined;
  const selectedSkill =
    selection?.kind === "skill" ? data?.skills.find((v) => v.skill.id === selection.id) : undefined;
  const hasDetail = Boolean(selectedApp || selectedPlugin || selectedSkill);

  // An item that vanished (a custom server removed elsewhere) returns to the
  // catalog — render-time adjustment, guarded so a loading cache doesn't bounce.
  if (selection && data && !hasDetail) setSelection(null);

  const open = (kind: "app" | "plugin" | "skill", id: string) => setSelection({ kind, id });
  const back = () => setSelection(null);
  const trailFor = (title: string): Crumb[] => {
    const section = selection?.kind === "plugin" ? "plugins" : `${selection?.kind ?? "app"}s`;
    const tabLabel = TABS.find((t) => t.id === section)?.label ?? "Apps";
    return [
      { label: "Customize", onClick: back },
      {
        label: tabLabel,
        onClick: () => {
          setTab(section as Tab);
          back();
        },
      },
      { label: title },
    ];
  };

  return (
    <SidebarInset className="min-w-0">
      <div className="bg-bg-surface border-border-subtle flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-xl border">
        <SidebarMobileBar title="Customize" />
        <ScrollArea className={cn("min-h-0 flex-1", hasDetail && "hidden")}>
          <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 pt-6 pb-16 sm:px-8 sm:pt-12">
            <header className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <h1 className="text-text-primary text-xl font-semibold">Customize</h1>
                <p className="text-text-tertiary text-sm">
                  Apps, plugins and skills for every agent, in every project.
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <Plus className="h-3.5 w-3.5" />
                    Add your own
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onSelect={() => setAddMode("mcp")}>
                    <Server className="h-3.5 w-3.5" />
                    MCP server
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setAddMode("skill")}>
                    <BookOpen className="h-3.5 w-3.5" />
                    Skill from GitHub
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </header>

            <div className="flex flex-col gap-3">
              <label className="border-border-subtle bg-bg-elevated focus-within:border-border-default flex h-9 items-center gap-2 rounded-lg border px-3 transition-colors duration-150">
                <Search className="text-text-muted h-3.5 w-3.5 shrink-0" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search apps, plugins and skills"
                  className="text-text-primary placeholder:text-text-muted min-w-0 flex-1 bg-transparent text-sm outline-none"
                />
              </label>
              <div className="flex items-center justify-between gap-3">
                <div role="tablist" className="flex items-center gap-1">
                  {TABS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === t.id}
                      onClick={() => setTab(t.id)}
                      className={cn(
                        "control-interaction flex h-7 items-center gap-1.5 rounded-full px-3 text-sm",
                        tab === t.id
                          ? "bg-bg-selection text-text-primary font-medium"
                          : "text-text-tertiary hover:text-text-secondary"
                      )}
                    >
                      {t.label}
                      {counts[t.id] > 0 && (
                        <span
                          className={cn(
                            "text-2xs",
                            tab === t.id ? "text-text-tertiary" : "text-text-disabled"
                          )}
                        >
                          {counts[t.id]}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  aria-pressed={installedOnly}
                  onClick={() => setInstalledOnly((v) => !v)}
                  className={cn(
                    "control-interaction flex h-7 items-center gap-1.5 rounded-full px-3 text-xs",
                    installedOnly
                      ? "bg-bg-selection text-text-primary font-medium"
                      : "text-text-tertiary hover:text-text-secondary"
                  )}
                >
                  {installedOnly && <Check className="h-3 w-3" />}
                  Installed
                </button>
              </div>
            </div>

            {error ? (
              <EmptyState title="Couldn't load Customize" detail={getErrorMessage(error)} />
            ) : isLoading || !data ? (
              <LoadingGrid />
            ) : tab === "apps" ? (
              <AppsView apps={apps} onOpen={(id) => open("app", id)} />
            ) : tab === "plugins" ? (
              <PluginsView
                plugins={plugins}
                iconsFor={(ids) => ids.map((id) => appIcons.get(id))}
                onOpen={(id) => open("plugin", id)}
              />
            ) : (
              <SkillsView
                skills={skills}
                localSkills={installedOnly || needle ? [] : (localSkills.data ?? [])}
                onOpen={(id) => open("skill", id)}
              />
            )}
          </div>
        </ScrollArea>

        {hasDetail && data && (
          <ScrollArea key={`${selection?.kind}:${selection?.id}`} className="min-h-0 flex-1">
            {selectedApp ? (
              <AppDetail
                view={selectedApp}
                snapshot={data}
                trail={trailFor(selectedApp.app.name)}
                onBack={back}
                onOpenPlugin={(id) => open("plugin", id)}
              />
            ) : selectedPlugin ? (
              <PluginDetail
                view={selectedPlugin}
                snapshot={data}
                trail={trailFor(selectedPlugin.plugin.title)}
                onBack={back}
                onOpenApp={(id) => open("app", id)}
                onOpenSkill={(id) => open("skill", id)}
              />
            ) : selectedSkill ? (
              <SkillDetail
                view={selectedSkill}
                snapshot={data}
                trail={trailFor(selectedSkill.skill.title)}
                onBack={back}
                onOpenApp={(id) => open("app", id)}
              />
            ) : null}
          </ScrollArea>
        )}
      </div>

      {addMode && (
        <AddCustomDialog
          mode={addMode}
          onClose={() => setAddMode(null)}
          onAdded={(kind, id) => {
            setAddMode(null);
            setTab(kind === "app" ? "apps" : "skills");
            setSelection({ kind, id });
          }}
        />
      )}
    </SidebarInset>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function filterItems<T extends { installed: boolean }>(
  items: T[] | undefined,
  needle: string,
  installedOnly: boolean,
  fields: (item: T) => string[]
): T[] {
  return (items ?? []).filter(
    (item) =>
      (!installedOnly || item.installed) &&
      (!needle || fields(item).some((field) => field.toLowerCase().includes(needle)))
  );
}

function groupByCategory<T>(
  items: T[],
  categoriesOf: (item: T) => IntegrationCategory[]
): Array<{ category: IntegrationCategory; items: T[] }> {
  return CATEGORY_ORDER.map((category) => ({
    category,
    // An item sits in its first category only, so it shows up once.
    items: items.filter((item) => categoriesOf(item)[0] === category),
  })).filter((group) => group.items.length > 0);
}

function AppsView({ apps, onOpen }: { apps: AppView[]; onOpen: (id: string) => void }) {
  if (apps.length === 0) return <EmptyState title="No apps match" detail="Try another search." />;
  const installed = apps.filter((v) => v.installed);
  const rest = apps.filter((v) => !v.installed);
  const featured = rest.filter((v) => v.app.featured);
  const others = rest.filter((v) => !v.app.featured);
  return (
    <div className="flex flex-col gap-7">
      {installed.length > 0 && (
        <Section title="Installed">
          {installed.map((view) => (
            <AppRow key={view.app.id} view={view} onOpen={onOpen} />
          ))}
        </Section>
      )}
      {featured.length > 0 && (
        <Section title="Featured">
          {featured.map((view) => (
            <AppRow key={view.app.id} view={view} onOpen={onOpen} />
          ))}
        </Section>
      )}
      {groupByCategory(others, (v) => v.app.categories).map(({ category, items }) => (
        <Section key={category} title={INTEGRATION_CATEGORY_LABELS[category]}>
          {items.map((view) => (
            <AppRow key={view.app.id} view={view} onOpen={onOpen} />
          ))}
        </Section>
      ))}
    </div>
  );
}

function PluginsView({
  plugins,
  iconsFor,
  onOpen,
}: {
  plugins: PluginView[];
  iconsFor: (appIds: string[]) => Array<string | undefined>;
  onOpen: (id: string) => void;
}) {
  if (plugins.length === 0) {
    return <EmptyState title="No plugins match" detail="Try another search." />;
  }
  return (
    <div className="flex flex-col gap-7">
      {groupByCategory(plugins, (v) => v.plugin.categories).map(({ category, items }) => (
        <Section key={category} title={INTEGRATION_CATEGORY_LABELS[category]}>
          {items.map((view) => (
            <PluginRow
              key={view.plugin.id}
              view={view}
              icons={iconsFor(view.plugin.apps)}
              onOpen={onOpen}
            />
          ))}
        </Section>
      ))}
    </div>
  );
}

function SkillsView({
  skills,
  localSkills,
  onOpen,
}: {
  skills: SkillView[];
  localSkills: Array<{ name: string; description: string }>;
  onOpen: (id: string) => void;
}) {
  if (skills.length === 0 && localSkills.length === 0) {
    return <EmptyState title="No skills match" detail="Try another search." />;
  }
  const installed = skills.filter((v) => v.installed);
  const rest = skills.filter((v) => !v.installed);
  return (
    <div className="flex flex-col gap-7">
      {installed.length > 0 && (
        <Section title="Added">
          {installed.map((view) => (
            <SkillRow key={view.skill.id} view={view} onOpen={onOpen} />
          ))}
        </Section>
      )}
      {groupByCategory(rest, (v) => v.skill.categories).map(({ category, items }) => (
        <Section key={category} title={INTEGRATION_CATEGORY_LABELS[category]}>
          {items.map((view) => (
            <SkillRow key={view.skill.id} view={view} onOpen={onOpen} />
          ))}
        </Section>
      ))}
      {localSkills.length > 0 && (
        <Section
          title="Already on this computer"
          detail="Skills in ~/.claude/skills or ~/.agents/skills that Deus didn't add."
        >
          {localSkills.map((skill) => (
            <Row
              key={skill.name}
              icon={<ItemIcon name={skill.name} fallback={BookOpen} />}
              title={skill.name}
              description={skill.description}
              status={{ text: "On this computer", tone: "muted" }}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function AppRow({ view, onOpen }: { view: AppView; onOpen: (id: string) => void }) {
  const install = useInstall();
  const connect = useConnectFlow();
  const status = appStatus(view);
  const { app } = view;

  // "+" is the shortest path to a working app: sign in straight away, add an
  // app that needs nothing, and open its page when a key must be typed.
  const quickAdd = () => {
    if (app.auth.kind === "oauth" || app.auth.kind === "managed") {
      connect.start(view);
    } else if (app.auth.kind === "none") {
      install.mutate({ kind: "app", id: app.id });
    } else {
      onOpen(app.id);
    }
  };

  const action =
    view.readiness === "not_installed" && view.available ? (
      <AddButton
        label={`Add ${app.name}`}
        busy={install.isPending || connect.pending}
        onClick={quickAdd}
      />
    ) : view.readiness === "ready" ? (
      <Check className="text-text-muted h-3.5 w-3.5" />
    ) : null;

  return (
    <Row
      icon={
        <ItemIcon
          icon={app.icon}
          name={app.name}
          fallback={view.source === "custom" ? Server : undefined}
        />
      }
      title={app.name}
      description={app.description}
      status={status}
      action={action}
      onOpen={() => onOpen(app.id)}
    />
  );
}

function PluginRow({
  view,
  icons,
  onOpen,
}: {
  view: PluginView;
  icons: Array<string | undefined>;
  onOpen: (id: string) => void;
}) {
  const install = useInstall();
  const { plugin } = view;
  const parts = `${plugin.apps.length} app${plugin.apps.length === 1 ? "" : "s"} · ${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}`;
  return (
    <Row
      icon={<PluginIcon icons={icons} name={plugin.title} fallback={Package} />}
      title={plugin.title}
      description={plugin.tagline}
      status={pluginStatus(view) ?? { text: parts, tone: "muted" }}
      action={
        view.installed ? (
          <Check className="text-text-muted h-3.5 w-3.5" />
        ) : (
          <AddButton
            label={`Install ${plugin.title}`}
            busy={install.isPending}
            onClick={() =>
              install.mutate(
                { kind: "plugin", id: plugin.id },
                {
                  onSuccess: () => onOpen(plugin.id),
                }
              )
            }
          />
        )
      }
      onOpen={() => onOpen(plugin.id)}
    />
  );
}

function SkillRow({ view, onOpen }: { view: SkillView; onOpen: (id: string) => void }) {
  const install = useInstall();
  const { skill } = view;
  return (
    <Row
      icon={<ItemIcon name={skill.title} fallback={BookOpen} />}
      title={skill.title}
      description={skill.description}
      status={skillStatus(view)}
      meta={skill.publisher}
      action={
        view.readiness === "not_installed" ? (
          <AddButton
            label={`Add ${skill.title}`}
            busy={install.isPending}
            onClick={() => install.mutate({ kind: "skill", id: skill.id })}
          />
        ) : view.readiness === "installing" ? (
          <Loader2 className="text-text-muted h-3.5 w-3.5 animate-spin" />
        ) : view.readiness === "ready" ? (
          <Check className="text-text-muted h-3.5 w-3.5" />
        ) : null
      }
      onOpen={() => onOpen(skill.id)}
    />
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Section({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-text-secondary text-sm font-medium">{title}</h2>
        {detail && <span className="text-text-muted text-xs">{detail}</span>}
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-1 md:grid-cols-2">{children}</div>
    </section>
  );
}

function Row({
  icon,
  title,
  description,
  status,
  meta,
  action,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  status?: StatusLabel | null;
  meta?: string;
  action?: ReactNode;
  onOpen?: () => void;
}) {
  return (
    <div className="group hover:bg-foreground/[0.03] relative flex items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-150">
      {onOpen && (
        <button
          type="button"
          aria-label={`Open ${title}`}
          onClick={onOpen}
          className="focus-visible:ring-ring absolute inset-0 rounded-lg focus-visible:ring-2 focus-visible:outline-none"
        />
      )}
      {icon}
      <div className="pointer-events-none flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-text-primary truncate text-sm font-medium">{title}</span>
          {status ? (
            <span className={cn("shrink-0 text-xs", TONE_CLASS[status.tone])}>{status.text}</span>
          ) : meta ? (
            <span className="text-text-muted shrink-0 truncate text-xs">{meta}</span>
          ) : null}
        </div>
        <span className="text-text-tertiary truncate text-xs">{description}</span>
      </div>
      {action && <div className="relative flex w-7 shrink-0 justify-center">{action}</div>}
    </div>
  );
}

function AddButton({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={busy}
      onClick={onClick}
      className="control-interaction text-text-secondary hover:text-text-primary hover:bg-control-hover active:bg-control-pressed flex h-7 w-7 items-center justify-center rounded-lg disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-4 w-4" />}
    </button>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center gap-1 py-16 text-center">
      <span className="text-text-secondary text-sm font-medium">{title}</span>
      <span className="text-text-muted text-xs">{detail}</span>
    </div>
  );
}

function LoadingGrid() {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-1 md:grid-cols-2">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2">
          <div className="bg-bg-elevated h-9 w-9 animate-pulse rounded-lg" />
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="bg-bg-elevated h-3 w-24 animate-pulse rounded" />
            <div className="bg-bg-elevated h-2.5 w-48 animate-pulse rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
