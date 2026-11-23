import { useState, useMemo, useEffect, useCallback, useRef, type CSSProperties } from "react";
import { Plus, X, MessageSquarePlus, ArrowRight } from "lucide-react";
import { CopyIcon } from "@/components/ui/copy-icon";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FileDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation } from "@pierre/diffs/react";
import { getSingularPatch, parseDiffFromFile } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { FileDiff as WorkspaceFileDiff } from "@shared/api/workspaces";
import type { FileChange } from "@shared/types/workspace";
import { useDiffOptions } from "@/shared/lib/diffOptions";
import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";
import { serializeDiffCommentReference } from "@/features/session/lib/parseDiffCommentTags";
import { workspaceLayoutActions } from "@/features/workspace/store";
import { useIsMobile } from "@/shared/hooks/use-mobile";

interface DiffViewerProps {
  fileChange: FileChange;
  data?: WorkspaceFileDiff;
  isLoading?: boolean;
  error?: string | null;
  onClose?: () => void;
  /** When true, renders with natural height (no h-full / internal scroll) for stacking inside a scrollable parent */
  embedded?: boolean;
  /** Required for sending diff comments to the chat input */
  workspaceId?: string;
}

/**
 * DiffViewer - Git diff viewer powered by @pierre/diffs
 *
 * Renders unified diffs with syntax highlighting, word-level change detection,
 * and hunk separators. Uses Shadow DOM for style isolation.
 *
 * Data flow: Backend returns raw diff + file contents → FileDiff parses and renders
 */
type CommentSide = "additions" | "deletions";

interface DiffComment {
  id: string;
  lineNumber: number;
  side: CommentSide;
  text: string;
  createdAt: string;
}

interface DiffCommentDraft {
  lineNumber: number;
  side: CommentSide;
  text: string;
}

interface DiffCommentMeta {
  id: string;
  text: string;
  createdAt?: string;
  isDraft?: boolean;
}

export function DiffViewer({
  fileChange,
  data,
  isLoading = false,
  error: errorProp = null,
  onClose,
  embedded = false,
  workspaceId,
}: DiffViewerProps) {
  const { copy, copied } = useCopyToClipboard();
  const [comments, setComments] = useState<DiffComment[]>([]);
  const [draftComment, setDraftComment] = useState<DiffCommentDraft | null>(null);
  const [showAll, setShowAll] = useState(false);
  const isMobile = useIsMobile();

  // Mobile long-press tracking
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastEnteredLineRef = useRef<{ lineNumber: number; side: CommentSide } | null>(null);

  const baseDiffOptions = useDiffOptions<DiffCommentMeta>();

  const filePath = fileChange.file;
  const diff = data?.diff ?? "";
  const diffIsEmpty = diff.trim().length === 0;
  const hasContent = !isLoading && !errorProp && !diffIsEmpty;

  const displayFileDiff = useMemo(() => {
    if (!data || diffIsEmpty) return null;
    const { file, previous_path, status } = fileChange;
    const { old_content, new_content } = data;
    let parsed: FileDiffMetadata | undefined;
    if (old_content != null && new_content != null && old_content !== new_content) {
      try {
        const full = parseDiffFromFile(
          { name: previous_path ?? file, contents: old_content },
          { name: file, contents: new_content }
        );
        if (full.hunks.length) parsed = full;
      } catch (error) {
        console.warn("Failed to generate full diff, falling back to patch diff", error);
      }
    }
    try {
      // Pierre needs an unquoted diff --git header to read the hunks. Git supplies both names separately.
      parsed ??= getSingularPatch(
        data.diff.replace(/^diff --git [^\n]*/, "diff --git a/file b/file")
      );
      const types = {
        added: "new",
        modified: "change",
        deleted: "deleted",
        renamed:
          parsed.hunks.length || parsed.type === "rename-changed"
            ? "rename-changed"
            : "rename-pure",
      } as const;
      return { ...parsed, name: file, prevName: previous_path, type: types[status] };
    } catch (error) {
      console.warn("Failed to parse patch diff", error);
      return null;
    }
  }, [data, diffIsEmpty, fileChange]);
  const canExpand = displayFileDiff?.isPartial === false;

  useEffect(() => {
    setComments([]);
    setDraftComment(null);
    setShowAll(false);
  }, [filePath]);

  // Disable word-level diffs for large diffs (2000 line threshold)
  const isLargeDiff = useMemo(
    () => displayFileDiff != null && countDiffLines(displayFileDiff) > LARGE_DIFF_LINE_THRESHOLD,
    [displayFileDiff]
  );

  const createCommentId = () =>
    `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const handleStartComment = useCallback(
    (getHoveredLine: () => { lineNumber: number; side: CommentSide } | undefined) => {
      const hovered = getHoveredLine();
      if (!hovered) return;

      setDraftComment((current) => {
        if (current && current.lineNumber === hovered.lineNumber && current.side === hovered.side) {
          return current;
        }
        return { lineNumber: hovered.lineNumber, side: hovered.side, text: "" };
      });
    },
    []
  );

  // Mobile: open comment on line tap
  const handleMobileLineClick = useCallback(
    (props: { lineNumber: number; annotationSide: CommentSide }) => {
      setDraftComment((current) => {
        if (current?.lineNumber === props.lineNumber && current.side === props.annotationSide)
          return current;
        return { lineNumber: props.lineNumber, side: props.annotationSide, text: "" };
      });
    },
    []
  );

  // Track which line the finger is over (for long-press)
  const handleLineEnter = useCallback(
    (props: { lineNumber: number; annotationSide: CommentSide }) => {
      lastEnteredLineRef.current = { lineNumber: props.lineNumber, side: props.annotationSide };
    },
    []
  );

  const handleLineLeave = useCallback(() => {
    lastEnteredLineRef.current = null;
  }, []);

  // Long-press touch handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // Cancel any existing timer before arming a new one — multi-touch
    // (pinch-to-zoom) fires a second touchstart that would orphan the first.
    clearTimeout(longPressTimerRef.current);
    if (e.touches.length !== 1) {
      touchStartRef.current = null;
      return;
    }

    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    longPressTimerRef.current = setTimeout(() => {
      if (lastEnteredLineRef.current) {
        const { lineNumber, side } = lastEnteredLineRef.current;
        setDraftComment((current) => {
          if (current?.lineNumber === lineNumber && current.side === side) return current;
          return { lineNumber, side, text: "" };
        });
      }
    }, 500);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    // Cancel long-press if finger moves more than 10px (user is scrolling)
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      clearTimeout(longPressTimerRef.current);
      touchStartRef.current = null;
      lastEnteredLineRef.current = null;
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    clearTimeout(longPressTimerRef.current);
    touchStartRef.current = null;
    lastEnteredLineRef.current = null;
  }, []);

  // touchcancel fires during scroll handoff, incoming calls, etc. — same cleanup.
  const handleTouchCancel = handleTouchEnd;

  // Clean up long-press timer on unmount
  useEffect(() => () => clearTimeout(longPressTimerRef.current), []);

  const diffOptions = useMemo(
    () => ({
      ...baseDiffOptions,
      // Library-internal overflow: always "scroll" so the CSS grid computes
      // column widths correctly. The CONTAINER div handles embedded vs standalone
      // overflow separately via diffContainerStyle (height: auto + overflow: visible).
      overflow: "scroll" as const,
      disableFileHeader: true,
      enableGutterUtility: hasContent,
      expandUnchanged: showAll && canExpand,
      ...(isLargeDiff && { lineDiffType: "none" as const }),
      // Mobile: tap or long-press a line to open comment
      ...(isMobile &&
        hasContent && {
          onLineClick: handleMobileLineClick,
          onLineEnter: handleLineEnter,
          onLineLeave: handleLineLeave,
        }),
    }),
    [
      baseDiffOptions,
      canExpand,
      handleLineEnter,
      handleLineLeave,
      handleMobileLineClick,
      hasContent,
      isMobile,
      isLargeDiff,
      showAll,
    ]
  );

  const handleSaveDraft = useCallback(() => {
    const draft = draftComment;
    if (!draft) return;
    const trimmed = draft.text.trim();
    if (!trimmed) {
      setDraftComment(null);
      return;
    }
    const newComment: DiffComment = {
      id: createCommentId(),
      lineNumber: draft.lineNumber,
      side: draft.side,
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    setComments((prev) => [...prev, newComment]);
    setDraftComment(null);
  }, [draftComment]);

  const handleCancelDraft = useCallback(() => {
    setDraftComment(null);
  }, []);

  const handleRemoveComment = useCallback((id: string) => {
    setComments((prev) => prev.filter((comment) => comment.id !== id));
  }, []);

  const formatCommentForChat = useCallback(
    (comment: DiffComment, lineNumber: number, side: CommentSide) => {
      const fileLabel = filePath || "file";
      const sideLabel = side === "additions" ? "addition" : "deletion";
      return serializeDiffCommentReference({
        file: fileLabel,
        line: lineNumber,
        side: sideLabel,
        text: comment.text,
      });
    },
    [filePath]
  );

  const handleSendToChat = useCallback(
    (comment: DiffComment) => {
      if (!workspaceId) return;
      const sid = workspaceLayoutActions.getLayout(workspaceId).activeChatTabSessionId;
      if (!sid) return;
      const text = formatCommentForChat(comment, comment.lineNumber, comment.side);
      sessionComposerActions.appendDraft(sid, text);
    },
    [formatCommentForChat, workspaceId]
  );

  const lineAnnotations = useMemo<DiffLineAnnotation<DiffCommentMeta>[]>(
    () => [
      ...comments.map((comment) => ({
        side: comment.side,
        lineNumber: comment.lineNumber,
        metadata: {
          id: comment.id,
          text: comment.text,
          createdAt: comment.createdAt,
        },
      })),
      ...(draftComment
        ? [
            {
              side: draftComment.side,
              lineNumber: draftComment.lineNumber,
              metadata: {
                id: "draft",
                text: draftComment.text,
                isDraft: true,
              },
            },
          ]
        : []),
    ],
    [comments, draftComment]
  );

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<DiffCommentMeta>) => {
      const meta = annotation.metadata;
      if (!meta) return null;

      if (meta.isDraft) {
        const draft = draftComment;
        return (
          <div className="diff-comment-card">
            <Textarea
              value={draft?.text ?? ""}
              onChange={(event) =>
                setDraftComment((current) =>
                  current ? { ...current, text: event.target.value } : current
                )
              }
              placeholder="Add a review comment…"
              className="min-h-[88px] text-sm"
            />
            <div className="diff-comment-actions">
              <Button
                size="sm"
                className="diff-comment-save"
                onClick={handleSaveDraft}
                disabled={!draft?.text.trim()}
              >
                Save comment
              </Button>
              <Button size="sm" variant="ghost" onClick={handleCancelDraft}>
                Cancel
              </Button>
            </div>
          </div>
        );
      }

      const savedComment: DiffComment = {
        id: meta.id,
        lineNumber: annotation.lineNumber,
        side: annotation.side,
        text: meta.text,
        createdAt: meta.createdAt ?? "",
      };

      return (
        <div className="diff-comment-card">
          <p className="diff-comment-text">{meta.text}</p>
          <div className="diff-comment-actions">
            <Button size="sm" variant="ghost" onClick={() => handleSendToChat(savedComment)}>
              <MessageSquarePlus className="h-3.5 w-3.5" />
              Add to chat
            </Button>
            <Button size="sm" variant="ghost" onClick={() => handleRemoveComment(meta.id)}>
              Remove
            </Button>
          </div>
        </div>
      );
    },
    [draftComment, handleCancelDraft, handleRemoveComment, handleSaveDraft, handleSendToChat]
  );

  const headerActions = (
    <div className="diff-header-actions">
      <button
        type="button"
        className="diff-header-btn"
        onClick={() => setShowAll((prev) => !prev)}
        disabled={!canExpand}
        aria-pressed={showAll}
        title={canExpand ? undefined : "Full file context unavailable"}
      >
        {showAll ? "Collapse" : "Show all"}
      </button>
      <button
        type="button"
        className="diff-header-icon"
        onClick={() => void copy(diff)}
        title={copied ? "Copied" : "Copy diff"}
      >
        <CopyIcon copied={copied} className="size-3.5" />
      </button>
      {onClose && (
        <button type="button" className="diff-header-icon" onClick={onClose} title="Close diff">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  const headerTitle = useMemo(() => {
    if (!displayFileDiff) return null;
    if (displayFileDiff.prevName) {
      return (
        <span className="diff-viewer-title">
          <span className="diff-viewer-title-muted">{displayFileDiff.prevName}</span>
          <ArrowRight className="h-3.5 w-3.5 opacity-60" />
          <span>{displayFileDiff.name}</span>
        </span>
      );
    }
    return <span className="diff-viewer-title">{displayFileDiff.name}</span>;
  }, [displayFileDiff]);

  const diffContainerStyle = useMemo<CSSProperties>(
    () => ({
      height: embedded ? "auto" : "100%",
      overflow: embedded ? "visible" : "auto",
      // CSS variables pierce Shadow DOM — inline is the reliable delivery path
      "--diffs-font-size": "11px",
      "--diffs-line-height": "16px",
    }),
    [embedded]
  );

  return (
    <div className={embedded ? "" : "bg-background flex h-full flex-col overflow-hidden"}>
      {hasContent && displayFileDiff && !embedded && (
        <div className="diff-viewer-header">
          <div className="min-w-0 flex-1">{headerTitle}</div>
          {headerActions}
        </div>
      )}

      {/* Diff content */}
      <div
        className={embedded ? "relative" : "relative min-h-0 flex-1 overflow-hidden"}
        {...(isMobile &&
          hasContent && {
            onTouchStart: handleTouchStart,
            onTouchMove: handleTouchMove,
            onTouchEnd: handleTouchEnd,
            onTouchCancel: handleTouchCancel,
            onContextMenu: (e: React.MouseEvent) => {
              const target = e.target as HTMLElement;
              if (target.closest("textarea, input, [contenteditable]")) return;
              e.preventDefault();
            },
          })}
      >
        {isLoading ? (
          <div className="flex h-full items-center justify-center px-6 py-10">
            <div className="w-full max-w-none animate-pulse space-y-3">
              <div className="bg-muted/40 h-4 w-32 rounded-full" />
              {["w-4/5", "w-3/4", "w-5/6", "w-2/3", "w-4/6", "w-3/5"].map((width, index) => (
                <div key={index} className="flex items-center gap-3">
                  <div className="bg-muted/30 h-3 w-10 rounded-md" />
                  <div className={`h-3 ${width} bg-muted/30 rounded-md`} />
                </div>
              ))}
            </div>
          </div>
        ) : errorProp ? (
          <div
            className={`text-muted-foreground/60 flex items-center justify-center ${embedded ? "py-6" : "h-64"}`}
          >
            <div className="flex max-w-sm flex-col items-center gap-2 text-center">
              <p className="text-sm">{errorProp}</p>
            </div>
          </div>
        ) : diffIsEmpty ? (
          <div
            className={`text-muted-foreground/60 flex items-center justify-center ${embedded ? "py-6" : "h-64"}`}
          >
            <p className="text-sm">No changes</p>
          </div>
        ) : !displayFileDiff ? (
          <div
            className={`text-muted-foreground/60 flex items-center justify-center ${embedded ? "py-6" : "h-64"}`}
          >
            <p className="text-sm">Unable to render diff</p>
          </div>
        ) : (
          <FileDiff<DiffCommentMeta>
            fileDiff={displayFileDiff}
            options={diffOptions}
            disableWorkerPool
            lineAnnotations={lineAnnotations}
            renderAnnotation={renderAnnotation}
            renderGutterUtility={(getHoveredLine) => (
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handleStartComment(getHoveredLine);
                }}
                className="diff-hover-action"
                title="Add comment"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
            className="diffs-theme diffs-theme-compact"
            style={diffContainerStyle}
          />
        )}
      </div>
    </div>
  );
}

// Above this threshold, disable word-level diffs
const LARGE_DIFF_LINE_THRESHOLD = 2000;

function countDiffLines(fileDiff: FileDiffMetadata): number {
  let total = 0;
  for (const hunk of fileDiff.hunks) {
    total += hunk.additionCount + hunk.deletionCount;
  }
  return total;
}
