/**
 * Local-state image-attachment hook — used by the home screen composer,
 * which isn't tied to a session yet so has nowhere to put per-session
 * state. Inside the session (MessageInput), composer state lives in
 * sessionComposerStore, so that component reads attachments from the
 * store instead of this hook.
 *
 * The pure utilities (type whitelist, FileReader → preview, clipboard
 * extraction, Anthropic block building) live in `lib/imageAttachments.ts`
 * so both call-sites share them.
 */

import { useState, useCallback } from "react";
import {
  buildImageBlocks as buildBlocksFromAttachments,
  extractImagesFromClipboard as extractFromClipboard,
  processImageFiles,
  SUPPORTED_IMAGE_TYPES,
  type ImageAttachment,
} from "../lib/imageAttachments";

export { SUPPORTED_IMAGE_TYPES, type ImageAttachment };

export function useImageAttachments() {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);

  const processFiles = useCallback(async (files: File[]) => {
    const processed = await processImageFiles(files);
    if (processed.length) setAttachments((prev) => [...prev, ...processed]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  const extractImagesFromClipboard = useCallback(
    (e: React.ClipboardEvent): File[] => extractFromClipboard(e),
    []
  );

  const buildImageBlocks = useCallback(
    (): Array<Record<string, unknown>> | null => buildBlocksFromAttachments(attachments),
    [attachments]
  );

  return {
    attachments,
    setAttachments,
    processFiles,
    removeAttachment,
    clearAttachments,
    extractImagesFromClipboard,
    buildImageBlocks,
  };
}
