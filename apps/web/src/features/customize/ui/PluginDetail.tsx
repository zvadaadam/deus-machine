/**
 * PluginDetail — a bundle's page: what it is for, and its parts. Installing
 * adds every app and skill at once; apps that need an account say so here
 * and connect one by one, now or when an agent first needs them.
 */

import { BookOpen, Loader2, MoreHorizontal, Package } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import {
  INTEGRATION_CATEGORY_LABELS,
  type IntegrationsSnapshot,
  type PluginView,
} from "@shared/integrations/types";
import { useInstall, useUninstall } from "../api/integrations.queries";
import { appStatus, pluginStatus, skillStatus } from "../lib/status";
import { ItemIcon, PluginIcon } from "./ItemIcon";
import {
  AsideGroup,
  DetailPage,
  DetailSection,
  PartRow,
  StatusText,
  type Crumb,
} from "./DetailPage";

export function PluginDetail({
  view,
  snapshot,
  trail,
  onBack,
  onOpenApp,
  onOpenSkill,
}: {
  view: PluginView;
  snapshot: IntegrationsSnapshot;
  trail: Crumb[];
  onBack: () => void;
  onOpenApp: (id: string) => void;
  onOpenSkill: (id: string) => void;
}) {
  const { plugin } = view;
  const install = useInstall();
  const uninstall = useUninstall();
  const apps = plugin.apps.flatMap((id) => snapshot.apps.filter((a) => a.app.id === id));
  const skills = plugin.skills.flatMap((id) => snapshot.skills.filter((s) => s.skill.id === id));
  const connected = apps.filter((a) => a.readiness === "ready").length;

  return (
    <DetailPage
      trail={trail}
      onBack={onBack}
      icon={
        <PluginIcon
          icons={apps.map((a) => a.app.icon)}
          name={plugin.title}
          size="lg"
          fallback={Package}
        />
      }
      title={plugin.title}
      byline={<span>By {plugin.publisher}</span>}
      actions={
        view.installed ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More for ${plugin.title}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem
                className="text-destructive"
                onSelect={() => uninstall.mutate({ kind: "plugin", id: plugin.id })}
              >
                Remove plugin
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            size="sm"
            disabled={install.isPending}
            onClick={() => install.mutate({ kind: "plugin", id: plugin.id })}
          >
            {install.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Install plugin
          </Button>
        )
      }
      facts={[
        { label: "Status", value: <StatusText status={pluginStatus(view)} /> },
        { label: "Apps", value: apps.length },
        { label: "Connected", value: apps.length ? `${connected} of ${apps.length}` : "—" },
        { label: "Skills", value: skills.length },
      ]}
      aside={
        <>
          <AsideGroup title="Categories">
            <div className="flex flex-wrap gap-1">
              {plugin.categories.map((category) => (
                <span
                  key={category}
                  className="bg-bg-elevated text-text-secondary rounded-md px-1.5 py-0.5"
                >
                  {INTEGRATION_CATEGORY_LABELS[category]}
                </span>
              ))}
            </div>
          </AsideGroup>
          <AsideGroup title="How it installs">
            <span className="text-text-tertiary leading-relaxed">
              Its apps and skills reach every agent in every project. Apps that need an account can
              be connected later. Removing the plugin keeps anything you added yourself.
            </span>
          </AsideGroup>
        </>
      }
    >
      <DetailSection title="About">
        <p className="text-text-secondary text-sm leading-relaxed">{plugin.description}</p>
      </DetailSection>

      {apps.length > 0 && (
        <DetailSection title="Apps" count={apps.length}>
          <div className="flex flex-col">
            {apps.map((app) => (
              <PartRow
                key={app.app.id}
                icon={<ItemIcon icon={app.app.icon} name={app.app.name} size="sm" />}
                title={app.app.name}
                detail={app.app.description}
                status={appStatus(app)}
                onClick={() => onOpenApp(app.app.id)}
              />
            ))}
          </div>
        </DetailSection>
      )}

      {skills.length > 0 && (
        <DetailSection title="Skills" count={skills.length}>
          <div className="flex flex-col">
            {skills.map((skill) => (
              <PartRow
                key={skill.skill.id}
                icon={<ItemIcon name={skill.skill.title} size="sm" fallback={BookOpen} />}
                title={skill.skill.title}
                detail={skill.skill.description}
                status={skillStatus(skill)}
                onClick={() => onOpenSkill(skill.skill.id)}
              />
            ))}
          </div>
        </DetailSection>
      )}
    </DetailPage>
  );
}
