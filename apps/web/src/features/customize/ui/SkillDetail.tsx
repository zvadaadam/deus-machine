/**
 * SkillDetail — one skill's page: what it teaches (its SKILL.md, rendered),
 * where it comes from (a pinned commit) and which apps it expects. Adding it
 * puts its files where Claude and Codex load skills; it needs no account.
 */

import { BookOpen, ExternalLink, FileText, Loader2, MoreHorizontal, RefreshCw } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui";
import { Switch } from "@/components/ui/switch";
import { MarkdownRenderer } from "@/components/markdown";
import { getErrorMessage } from "@shared/lib/errors";
import {
  INTEGRATION_CATEGORY_LABELS,
  type IntegrationsSnapshot,
  type SkillView,
} from "@shared/integrations/types";
import { openExternal } from "@/platform/native/window";
import {
  useInstall,
  useUpdateSkill,
  useSetEnabled,
  useSkillContent,
  useUninstall,
} from "../api/integrations.queries";
import { appStatus, skillStatus } from "../lib/status";
import { ItemIcon } from "./ItemIcon";
import {
  AsideGroup,
  AsideLink,
  DetailPage,
  DetailSection,
  PartRow,
  StatusText,
  type Crumb,
} from "./DetailPage";

/** SKILL.md without its frontmatter: the page already shows name and description. */
function body(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export function SkillDetail({
  view,
  snapshot,
  trail,
  onBack,
  onOpenApp,
}: {
  view: SkillView;
  snapshot: IntegrationsSnapshot;
  trail: Crumb[];
  onBack: () => void;
  onOpenApp: (id: string) => void;
}) {
  const { skill } = view;
  const install = useInstall();
  const uninstall = useUninstall();
  const setEnabled = useSetEnabled();
  const update = useUpdateSkill();
  const content = useSkillContent(skill.id, view.installedRef);
  const requires = skill.requiresApps.flatMap((id) => snapshot.apps.filter((a) => a.app.id === id));
  const sourceUrl =
    skill.homepage ??
    `https://github.com/${skill.source.repo}/tree/${skill.source.ref}/${skill.source.path}`;

  return (
    <DetailPage
      trail={trail}
      onBack={onBack}
      icon={<ItemIcon name={skill.title} size="lg" fallback={BookOpen} />}
      title={skill.title}
      byline={
        <>
          <span>{skill.publisher}</span>
          <span className="text-text-muted">·</span>
          <span>
            {view.source === "custom" ? "Your skill" : skill.official ? "Official" : "Community"}
          </span>
        </>
      }
      actions={
        view.installed ? (
          <>
            <label className="text-text-secondary flex items-center gap-2 text-xs">
              <Switch
                checked={view.enabled}
                aria-label="Agents can use it"
                disabled={view.readiness === "installing" || view.readiness === "error"}
                onCheckedChange={(enabled) =>
                  setEnabled.mutate({ kind: "skill", id: skill.id, enabled })
                }
              />
              {view.enabled ? "On" : "Off"}
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`More for ${skill.title}`}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => update.mutate(skill.id)}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {view.updateAvailable ? "Update to the latest version" : "Download again"}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void openExternal(sourceUrl)}>
                  <ExternalLink className="h-3.5 w-3.5" />
                  View source
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onSelect={() =>
                    uninstall.mutate(
                      { kind: "skill", id: skill.id },
                      { onSuccess: view.source === "custom" ? onBack : undefined }
                    )
                  }
                >
                  Remove skill
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <Button
            size="sm"
            disabled={install.isPending}
            onClick={() => install.mutate({ kind: "skill", id: skill.id })}
          >
            {install.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Add skill
          </Button>
        )
      }
      facts={[
        { label: "Status", value: <StatusText status={skillStatus(view)} /> },
        { label: "Loads as", value: <span className="font-mono text-xs">{skill.name}</span> },
        {
          label: "Version",
          value: (
            <span className="font-mono text-xs">
              {(view.installedRef ?? skill.source.ref).slice(0, 7)}
            </span>
          ),
        },
        { label: "License", value: skill.license ?? "—" },
      ]}
      aside={
        <>
          <AsideGroup title="Categories">
            <div className="flex flex-wrap gap-1">
              {skill.categories.map((category) => (
                <span
                  key={category}
                  className="bg-bg-elevated text-text-secondary rounded-md px-1.5 py-0.5"
                >
                  {INTEGRATION_CATEGORY_LABELS[category]}
                </span>
              ))}
            </div>
          </AsideGroup>
          <AsideGroup title="Source">
            <AsideLink href={sourceUrl}>
              {skill.source.repo}
              {skill.source.path ? `/${skill.source.path}` : ""}
            </AsideLink>
          </AsideGroup>
          <AsideGroup title="Used by">
            <span className="text-text-tertiary leading-relaxed">
              Claude and Codex, in every project. The agent loads it when a task fits its
              description.
            </span>
          </AsideGroup>
          {content.data?.files && content.data.files.length > 1 && (
            <AsideGroup title={`Files · ${content.data.files.length}`}>
              {content.data.files.slice(0, 12).map((file) => (
                <span
                  key={file}
                  className="text-text-tertiary flex min-w-0 items-center gap-1.5 font-mono text-[11px]"
                >
                  <FileText className="h-3 w-3 shrink-0" />
                  <span className="truncate">{file}</span>
                </span>
              ))}
              {content.data.files.length > 12 && (
                <span className="text-text-muted">+{content.data.files.length - 12} more</span>
              )}
            </AsideGroup>
          )}
        </>
      }
    >
      <DetailSection title="About">
        <p className="text-text-secondary text-sm leading-relaxed">{skill.description}</p>
      </DetailSection>

      {view.error && view.readiness !== "installing" && (
        <div className="bg-destructive-tint flex items-center justify-between gap-3 rounded-lg px-3 py-2.5">
          <span className="text-destructive min-w-0 text-xs break-words">{view.error}</span>
          <Button
            variant="outline"
            size="xs"
            disabled={update.isPending}
            onClick={() => update.mutate(skill.id)}
          >
            Try again
          </Button>
        </div>
      )}

      {view.updateAvailable && view.readiness !== "installing" && (
        <div className="border-border-subtle flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
          <span className="text-text-tertiary text-xs">
            A newer version of this skill has been reviewed for Deus.
          </span>
          <Button
            variant="outline"
            size="xs"
            disabled={update.isPending}
            onClick={() => update.mutate(skill.id)}
          >
            Update
          </Button>
        </div>
      )}

      {requires.length > 0 && (
        <DetailSection title="Works with">
          <div className="flex flex-col">
            {requires.map((app) => (
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

      <DetailSection title="SKILL.md">
        <div className="border-border-subtle bg-bg-elevated/40 rounded-lg border px-5 py-4">
          {content.isLoading ? (
            <div className="flex flex-col gap-2">
              {[72, 96, 88, 60].map((width) => (
                <div
                  key={width}
                  className="bg-bg-elevated h-3 animate-pulse rounded"
                  style={{ width: `${width}%` }}
                />
              ))}
            </div>
          ) : content.error ? (
            <span className="text-text-muted text-xs">
              Couldn't load it: {getErrorMessage(content.error)}
            </span>
          ) : content.data ? (
            <div className="max-h-[560px] overflow-y-auto text-sm">
              <MarkdownRenderer proseClassName="markdown-content">
                {body(content.data.markdown)}
              </MarkdownRenderer>
            </div>
          ) : null}
        </div>
      </DetailSection>
    </DetailPage>
  );
}
