import { useState, useCallback } from "react";

// Anthropic API only supports these image formats for vision
export const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export interface ImageAttachment {
  id: string;
  file: File;
  preview: string;
  type: string;
}

/**
 * Shared image attachment state + handlers for any input that supports
 * pasting/dropping images. Used by both WelcomeView and MessageInput.
 *
 * Owns: attachment state, file processing (FileReader → base64 preview),
 * clipboard image extraction, and Anthropic content block building.
 *
 * Does NOT own: text paste handling, inspected elements, or combined
 * content assembly — those differ between consumers.
 */
export function useImageAttachments() {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);

  /** Convert image Files to base64 preview attachments via FileReader. */
  const processFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => SUPPORTED_IMAGE_TYPES.has(f.type));
    if (!imageFiles.length) return;
    const previews = await Promise.all(
      imageFiles.map(
        (file) =>
          new Promise<ImageAttachment | null>((resolve) => {
            const reader = new FileReader();
            reader.onload = (ev) =>
              resolve({
                id: crypto.randomUUID(),
                file,
                preview: ev.target?.result as string,
                type: file.type,
              });
            reader.onerror = () => resolve(null);
            reader.onabort = () => resolve(null);
            reader.readAsDataURL(file);
          })
      )
    );
    const valid = previews.filter(Boolean) as ImageAttachment[];
    if (valid.length) setAttachments((prev) => [...prev, ...valid]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  /**
   * Extract image files from a clipboard event.
   * Returns the files found; caller decides whether to preventDefault.
   */
  const extractImagesFromClipboard = useCallback((e: React.ClipboardEvent): File[] => {
    const files: File[] = [];
    if (e.clipboardData.items) {
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === "file" && SUPPORTED_IMAGE_TYPES.has(item.type)) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    }
    return files;
  }, []);

  /**
   * Build Anthropic API content blocks for the current image attachments.
   * Returns null if no images. Caller combines with their own text content.
   */
  const buildImageBlocks = useCallback((): Array<Record<string, unknown>> | null => {
    if (attachments.length === 0) return null;
    return attachments.map((attachment) => {
      const base64Data = attachment.preview.includes(",")
        ? attachment.preview.split(",")[1]
        : attachment.preview;
      return {
        type: "image",
        source: { type: "base64", media_type: attachment.type, data: base64Data },
      };
    });
  }, [attachments]);

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
