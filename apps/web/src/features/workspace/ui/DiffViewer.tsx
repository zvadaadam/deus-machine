import { useState, useMemo, useEffect, useCallback, useRef, type CSSProperties } from "react";
import { Copy, Check, Plus, X, MessageSquarePlus, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FileDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation } from "@pierre/diffs/react";
import { getSingularPatch, parseDiffFromFile } from "@pierre/diffs";
import type { FileContents, FileDiffMetadata } from "@pierre/diffs";
import { useDiffOptions } from "@/shared/lib/diffOptions";
import { chatInsertActions } from "@/shared/stores/chatInsertStore";
import { useIsMobile } from "@/shared/hooks/use-mobile";

interface DiffViewerProps {
  filePath?: string;
  diff?: string;
  oldContent?: string | null;
  newContent?: string | null;
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
  filePath = "",
  diff = "",
  oldContent = null,
  newContent = null,
  isLoading = false,
  error: errorProp = null,
  onClose,
  embedded = false,
  workspaceId,
}: DiffViewerProps) {
  const [copied, setCopied] = useState(false);
  const [comments, setComments] = useState<DiffComment[]>([]);
  const [draftComment, setDraftComment] = useState<DiffCommentDraft | null>(null);
  const [showAll, setShowAll] = useState(false);
  const isMobile = useIsMobile();

  // Mobile long-press tracking
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastEnteredLineRef = useRef<{ lineNumber: number; side: CommentSide } | null>(null);

  const baseDiffOptions = useDiffOptions<DiffCommentMeta>();

  const handleCopyDiff = async () => {
    try {
      await navigator.clipboard.writeText(diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy diff:", error);
    }
  };

  const diffIsEmpty = diff.trim().length === 0;
  const hasContent = !isLoading && !errorProp && !diffIsEmpty;

  const { displayFileDiff, canExpand } = useMemo(() => {
    if (!diff.trim()) return { displayFileDiff: null, canExpand: false };
    const fallbackName = filePath || "file";
    const diffPaths = extractDiffPaths(diff);
    const oldName = diffPaths.oldPath || fallbackName;
    const newName = diffPaths.newPath || fallbackName;

    // Full-file parsing: when old + new content are available, use parseDiffFromFile
    // so the diff component has full context for expanding collapsed unchanged lines.
    const oldFile: FileContents | null =
      oldContent != null ? { name: oldName, contents: oldContent } : null;
    const newFile: FileContents | null =
      newContent != null ? { name: newName, contents: newContent } : null;
    if (oldFile && newFile) {
      try {
        const generated = parseDiffFromFile(oldFile, newFile);
        // Only use if it has hunks. Metadata-only changes (renames, chmod)
        // produce zero hunks — fall back to getSingularPatch for those.
        if (generated.hunks.length > 0) {
          return { displayFileDiff: applyDisplayNames(generated, fallbackName), canExpand: true };
        }
      } catch (error) {
        console.warn("Failed to generate full diff, falling back to patch diff", error);
      }
    }

    // Patch-only fallback — no full file context, so expand controls are dead.
    try {
      return {
        displayFileDiff: applyDisplayNames(getSingularPatch(diff), fallbackName),
        canExpand: false,
      };
    } catch (error) {
      console.warn("Failed to parse patch diff", error);
      return { displayFileDiff: null, canExpand: false };
    }
  }, [diff, filePath, newContent, oldContent]);

  useEffect(() => {
    // Reset comment state when file changes - intentional pattern for clearing related state
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      return [
        "### 💬 Diff comment",
        `- **File:** \`${fileLabel}\``,
        `- **Line:** ${lineNumber} (${sideLabel})`,
        "",
        comment.text,
      ].join("\n");
    },
    [filePath]
  );

  const handleSendToChat = useCallback(
    (comment: DiffComment) => {
      if (!workspaceId) return;
      const text = formatCommentForChat(comment, comment.lineNumber, comment.side);
      chatInsertActions.insertText(workspaceId, text);
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
        onClick={handleCopyDiff}
        title={copied ? "Copied" : "Copy diff"}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
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

function applyDisplayNames(fileDiff: FileDiffMetadata, fallbackName: string): FileDiffMetadata {
  const displayName = toBaseName(fileDiff.name || fallbackName);
  const displayPrev = fileDiff.prevName ? toBaseName(fileDiff.prevName) : undefined;
  return {
    ...fileDiff,
    name: displayName,
    prevName: displayPrev,
  };
}

function toBaseName(path: string): string {
  const cleaned = normalizeGitPath(path);
  const parts = cleaned.split("/");
  return parts[parts.length - 1] || cleaned;
}

function extractDiffPaths(diff: string): { oldPath?: string; newPath?: string } {
  let oldPath: string | undefined;
  let newPath: string | undefined;
  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("rename from ")) {
      oldPath = normalizeGitPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      newPath = normalizeGitPath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("diff --git ")) {
      const tokens = splitGitDiffTokens(line.slice("diff --git ".length));
      if (!oldPath && tokens[0]) oldPath = normalizeGitPath(tokens[0]);
      if (!newPath && tokens[1]) newPath = normalizeGitPath(tokens[1]);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const match = line.match(/^(---|\+\+\+)\s+([^\t\r\n]+)(.*)$/);
      if (!match) continue;
      const [, prefix, fileName] = match;
      if (fileName === "/dev/null") {
        continue;
      }
      if (prefix === "---" && !oldPath) {
        oldPath = normalizeGitPath(fileName);
      } else if (prefix === "+++" && !newPath) {
        newPath = normalizeGitPath(fileName);
      }
    }
    if (oldPath && newPath) {
      break;
    }
  }
  return { oldPath, newPath };
}

function splitGitDiffTokens(value: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < value.length && tokens.length < 2) {
    while (value[i] === " ") i += 1;
    if (i >= value.length) break;
    if (value[i] === '"') {
      let end = i + 1;
      while (end < value.length && value[end] !== '"') end += 1;
      tokens.push(value.slice(i, Math.min(end + 1, value.length)));
      i = end + 1;
    } else {
      let end = i;
      while (end < value.length && value[end] !== " ") end += 1;
      tokens.push(value.slice(i, end));
      i = end + 1;
    }
  }
  return tokens;
}

function normalizeGitPath(pathToken: string): string {
  if (!pathToken) return pathToken;
  const unquoted =
    pathToken.startsWith('"') && pathToken.endsWith('"') ? pathToken.slice(1, -1) : pathToken;
  return unquoted.replace(/^a\//, "").replace(/^b\//, "");
}
