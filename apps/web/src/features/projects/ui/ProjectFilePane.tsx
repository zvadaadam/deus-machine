import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { Button, Textarea } from "@/components/ui";
import { FilePreview } from "@/features/file-browser/ui/FilePreview";
import { getErrorMessage } from "@shared/lib/errors";
import { apiClient } from "@/shared/api/client";
import { useProjectAction, useProjectFile } from "../api/projects.queries";
import { projectMarkdownLinks } from "../lib/projectMarkdownLinks";

export interface ProjectFileSelection {
  path: string;
  revision: number;
  /** Editing permission for this context snapshot; result paths remain read-only. */
  editable?: boolean;
  fromReport?: boolean;
  availablePaths: string[];
}

export function ProjectFilePane({
  projectId,
  file,
  onClose,
  onOpenFile,
}: {
  projectId: string;
  file: ProjectFileSelection;
  onClose: () => void;
  onOpenFile: (file: ProjectFileSelection) => void;
}) {
  const canEdit = file.editable && !file.fromReport && !file.path.startsWith("results/");
  const query = useProjectFile(projectId, file.path, file.revision);
  const publish = useProjectAction(projectId);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [draft, setDraft] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [needsLatest, setNeedsLatest] = useState(false);
  const [comparison, setComparison] = useState<{ content: string; revision: number } | null>(null);
  const latest = useMutation({
    mutationFn: () =>
      apiClient.get<{ content: string; revision: number }>(
        `/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path: file.path })}`
      ),
    onSuccess: (value) => {
      setComparison(value);
      setNeedsLatest(false);
      setRequestId(crypto.randomUUID());
      publish.reset();
    },
  });
  const save = async () => {
    if (!canEdit || draft === null || needsLatest || publish.isPending || latest.isPending) return;
    try {
      await publish.mutateAsync({
        action: "content",
        requestId,
        path: file.path,
        content: draft,
        expectedRevision: comparison?.revision ?? file.revision,
      });
      // Publishing appends exactly one immutable snapshot, including on an
      // idempotent request retry; keep viewing the content just saved.
      if (mounted.current)
        onOpenFile({ ...file, revision: (comparison?.revision ?? file.revision) + 1 });
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 409) {
        setNeedsLatest(true);
        setComparison(null);
        latest.reset();
      }
    }
  };
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="border-border-subtle text-text-tertiary flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs">
        <span>Published version {file.revision}</span>
        {file.fromReport && <span>· Saved with this result</span>}
      </div>
      {draft === null ? (
        <div className="min-h-0 flex-1">
          <FilePreview
            filePath={file.path}
            content={query.data?.content}
            isLoading={query.isLoading}
            error={query.error}
            onClose={onClose}
            markdownLinks={projectMarkdownLinks(file.path, file.availablePaths, (path) =>
              onOpenFile({ ...file, path })
            )}
            actions={
              query.data &&
              canEdit && (
                <Button variant="ghost" size="xs" onClick={() => setDraft(query.data.content)}>
                  <Pencil />
                  Edit file
                </Button>
              )
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
          <p className="text-text-secondary truncate text-sm font-medium" title={file.path}>
            {file.path}
          </p>
          <div className="flex flex-col gap-4">
            {comparison && (
              <div className="flex flex-col gap-2">
                <p className="text-text-secondary text-xs font-medium">
                  Latest published · version {comparison.revision}
                </p>
                <Textarea
                  aria-label="Latest published content"
                  readOnly
                  className="min-h-40 resize-y font-mono text-sm"
                  value={comparison.content}
                />
                <p role="status" className="text-text-tertiary text-xs leading-relaxed">
                  {comparison.content === query.data?.content
                    ? "This file is unchanged. Other project files were updated; you can publish your draft below."
                    : "This file changed. Compare it with your draft and keep any changes you need before publishing."}
                </p>
              </div>
            )}
            <div className="flex flex-col gap-2">
              {comparison && <p className="text-text-secondary text-xs font-medium">Your draft</p>}
              <Textarea
                aria-label="File content"
                className="min-h-72 resize-y font-mono text-sm"
                value={draft}
                disabled={publish.isPending}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setRequestId(crypto.randomUUID());
                }}
              />
            </div>
          </div>
          {publish.isError && !needsLatest && (
            <p role="alert" className="text-destructive text-sm">
              {getErrorMessage(publish.error)}
            </p>
          )}
          {needsLatest && (
            <div className="flex flex-col items-start gap-2">
              <p role="alert" className="text-text-secondary text-xs leading-relaxed">
                Project files changed while you were editing. Your draft is still here. Load the
                latest version to compare before publishing.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={latest.isPending}
                onClick={() => latest.mutate()}
              >
                {latest.isPending ? "Loading latest version…" : "Load latest version"}
              </Button>
              {latest.isError && (
                <p role="alert" className="text-destructive text-xs">
                  {getErrorMessage(latest.error)}
                </p>
              )}
            </div>
          )}
          {query.data && (
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={publish.isPending || latest.isPending}
                onClick={() => {
                  setDraft(null);
                  setComparison(null);
                  setNeedsLatest(false);
                  latest.reset();
                  publish.reset();
                  setRequestId(crypto.randomUUID());
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!canEdit || publish.isPending || needsLatest || latest.isPending}
                onClick={save}
              >
                {publish.isPending
                  ? "Publishing…"
                  : comparison
                    ? "Publish my draft"
                    : "Publish changes"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
