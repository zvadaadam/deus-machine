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
import { browserWindowActions } from "@/features/browser/store/browserWindowStore";
import { useSession } from "@/features/session/context";
import {
  createWorkspacePreviewUrl,
  type ChatResource,
  type ResourceAction,
} from "@/features/session/lib/chatResources";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { getBaseURL } from "@/shared/config/api.config";
import { cn } from "@/shared/lib/utils";
import { native } from "@/platform/native";

interface ChatResourceCardsProps {
  resources: ChatResource[];
}

export function ChatResourceCards({ resources }: ChatResourceCardsProps) {
  const { workspaceId } = useSession();

  const openBrowserUrl = useCallback(
    (url: string) => {
      if (!workspaceId) return;
      workspaceLayoutActions.setActiveContentTab(workspaceId, "browser");
      browserWindowActions.requestNewTab(workspaceId, url);
    },
    [workspaceId]
  );

  const getBrowserPreviewUrl = useCallback(
    async (path: string) => {
      if (!workspaceId) return null;
      const baseUrl = await getBaseURL();
      return createWorkspacePreviewUrl(baseUrl, workspaceId, path);
    },
    [workspaceId]
  );

  const runAction = useCallback(
    async (action: ResourceAction) => {
      if (!workspaceId) return;

      if (action.kind === "deus-browser") {
        openBrowserUrl(action.url);
        return;
      }

      if (action.kind === "system-browser") {
        await native.window.openExternal(action.url);
        return;
      }

      if (action.kind === "deus-browser-file") {
        try {
          const url = await getBrowserPreviewUrl(action.path);
          if (url) openBrowserUrl(url);
        } catch (error) {
          console.warn("[chat-resource] Failed to open file preview:", error);
        }
        return;
      }

      if (action.kind === "deus-file") {
        workspaceLayoutActions.openFileInContent(workspaceId, action.path, action.target);
        return;
      }

      const target = { workspaceId, relativePath: action.path };

      if (action.kind === "system-file") {
        await native.files.openPath(target);
        return;
      }

      await native.files.revealInFinder(target);
    },
    [getBrowserPreviewUrl, openBrowserUrl, workspaceId]
  );

  if (resources.length === 0) return null;

  return (
    <div className="mt-1 flex max-w-full flex-col gap-2 px-2 pb-1">
      {resources.map((resource) => (
        <ResourceCard key={resource.id} resource={resource} onAction={runAction} />
      ))}
    </div>
  );
}

function ResourceCard({
  resource,
  onAction,
}: {
  resource: ChatResource;
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

      <ResourceActionButton resource={resource} onAction={onAction} />
    </div>
  );
}

function ResourceActionButton({
  resource,
  onAction,
}: {
  resource: ChatResource;
  onAction: (action: ResourceAction) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasSecondaryActions = resource.secondaryActions.length > 0;

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
        onClick={() => void onAction(resource.primaryAction)}
        className="h-8 gap-1.5 px-2.5"
      >
        <ActionIcon action={resource.primaryAction} className="h-3.5 w-3.5" />
        {resource.primaryAction.label}
      </Button>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <div className="border-border flex h-8 shrink-0 items-center rounded-md border">
        <button
          type="button"
          onClick={() => void onAction(resource.primaryAction)}
          className="text-foreground hover:bg-muted/70 flex h-full shrink-0 items-center gap-1.5 rounded-l-md px-2.5 text-sm font-medium transition-colors duration-150 ease-out"
        >
          <ActionIcon action={resource.primaryAction} className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0">{resource.primaryAction.label}</span>
        </button>

        <div className="bg-border h-4 w-px shrink-0" />

        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Choose open target for ${resource.title}`}
            className="text-muted-foreground hover:bg-muted/70 hover:text-foreground flex h-full shrink-0 items-center rounded-r-md px-1.5 transition-colors duration-150 ease-out"
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
        {resource.secondaryActions.map((action) => (
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
  if (resource.type === "website") return <Globe className={className} strokeWidth={1.5} />;

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
    return <Globe className={className} strokeWidth={1.5} />;
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
