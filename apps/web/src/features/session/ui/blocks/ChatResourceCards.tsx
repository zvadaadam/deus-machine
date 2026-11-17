import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  File,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Globe,
  Image,
  Presentation,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/features/session/context";
import type { ChatResource, ResourceAction } from "@/features/session/lib/chatResources";
import { offeredActions, runChatAction } from "@/features/session/lib/openFromChat";
import { cn } from "@/shared/lib/utils";

interface ChatResourceCardsProps {
  resources: ChatResource[];
}

export function ChatResourceCards({ resources }: ChatResourceCardsProps) {
  const { workspaceId, workspacePath, cloud } = useSession();

  const runAction = useCallback(
    async (action: ResourceAction) => {
      if (!workspaceId) return;
      await runChatAction(workspaceId, action, { cloud, folder: workspacePath });
    },
    [workspaceId, cloud, workspacePath]
  );

  if (resources.length === 0) return null;

  return (
    <div className="mt-1 flex max-w-full flex-col gap-2 px-2 pb-1">
      {resources.map((resource) => {
        const [primary, ...secondary] = offeredActions(resource, {
          cloud,
          folder: workspacePath,
        });
        return (
          <ResourceCard
            key={resource.id}
            resource={resource}
            primary={primary}
            secondary={secondary}
            onAction={runAction}
          />
        );
      })}
    </div>
  );
}

function ResourceCard({
  resource,
  primary,
  secondary,
  onAction,
}: {
  resource: ChatResource;
  primary: ResourceAction | undefined;
  secondary: ResourceAction[];
  onAction: (action: ResourceAction) => void | Promise<void>;
}) {
  return (
    <div
      className={cn(
        "border-border/70 bg-card/80 flex min-h-14 max-w-full items-center gap-3 rounded-lg border px-3 py-2 shadow-xs",
        "hover:bg-card transition-[background-color,border-color] duration-150 ease-out"
      )}
    >
      <div className="bg-muted/70 text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
        <ResourceIcon resource={resource} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{resource.title}</div>
        <div className="text-muted-foreground truncate text-xs">{resource.subtitle}</div>
      </div>

      {primary && (
        <ResourceActionButton
          title={resource.title}
          primary={primary}
          secondary={secondary}
          onAction={onAction}
        />
      )}
    </div>
  );
}

function ResourceActionButton({
  title,
  primary,
  secondary,
  onAction,
}: {
  title: string;
  primary: ResourceAction;
  secondary: ResourceAction[];
  onAction: (action: ResourceAction) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasSecondaryActions = secondary.length > 0;

  function handleOpen() {
    if (!hasSecondaryActions) return;
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    setOpen(true);
  }

  function handleClose() {
    if (!hasSecondaryActions) return;
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    closeTimeoutRef.current = setTimeout(() => setOpen(false), 80);
  }

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  if (!hasSecondaryActions) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void onAction(primary)}
        className="h-8 gap-1.5 px-2.5"
      >
        <ActionIcon action={primary} className="h-3.5 w-3.5" />
        {primary.label}
      </Button>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <div className="border-border flex h-8 shrink-0 items-center rounded-md border">
        <button
          type="button"
          onClick={() => void onAction(primary)}
          className="control-interaction text-foreground hover:bg-control-hover active:bg-control-pressed flex h-full shrink-0 items-center gap-1.5 rounded-l-lg px-2.5 text-sm font-normal"
        >
          <ActionIcon action={primary} className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0">{primary.label}</span>
        </button>

        <div className="bg-border h-4 w-px shrink-0" />

        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Choose open target for ${title}`}
            className="control-interaction text-muted-foreground hover:bg-control-hover active:bg-control-pressed hover:text-foreground flex h-full shrink-0 items-center rounded-r-lg px-1.5"
            onPointerEnter={handleOpen}
            onPointerLeave={handleClose}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
      </div>

      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="min-w-44"
        onPointerEnter={handleOpen}
        onPointerLeave={handleClose}
      >
        {secondary.map((action) => (
          <DropdownMenuItem key={getActionKey(action)} onClick={() => void onAction(action)}>
            <ActionIcon action={action} className="h-4 w-4" />
            <span>{action.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ResourceIcon({ resource }: { resource: ChatResource }) {
  const className = "h-4 w-4";
  if (resource.type === "website") return <Globe className={className} />;

  const extension = resource.path?.split(".").pop()?.toLowerCase();
  if (extension && ["avif", "gif", "jpeg", "jpg", "png", "webp"].includes(extension)) {
    return <Image className={className} />;
  }
  if (extension && ["csv", "tsv", "xls", "xlsm", "xlsx"].includes(extension)) {
    return <FileSpreadsheet className={className} />;
  }
  if (extension && ["ppt", "pptx"].includes(extension)) {
    return <Presentation className={className} />;
  }
  if (extension && ["doc", "docx", "md", "mdx", "pdf"].includes(extension)) {
    return <FileText className={className} />;
  }
  return <File className={className} />;
}

function ActionIcon({ action, className }: { action: ResourceAction; className: string }) {
  if (action.kind === "deus-browser" || action.kind === "deus-browser-file") {
    return <Globe className={className} />;
  }
  if (action.kind === "deus-file") return <FileText className={className} />;
  if (action.kind === "finder") return <FolderOpen className={className} />;
  return <ArrowUpRight className={className} />;
}

function getActionKey(action: ResourceAction): string {
  if (action.kind === "deus-browser" || action.kind === "system-browser") {
    return `${action.kind}:${action.url}`;
  }
  return `${action.kind}:${action.path}`;
}
