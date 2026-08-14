/**
 * Pure image-attachment utilities — shared between the session-scoped
 * composer store and the home-screen composer (which has its own local
 * state because no session exists yet).
 *
 * No React, no state. Just:
 *   - processImageFiles: File[] → ImageAttachment[] (FileReader → base64 preview)
 *   - extractImagesFromClipboard: clipboard event → File[]
 *   - buildImageParts: ImageAttachment[] → canonical ImagePartInput[] | null
 *   - buildMessageContent: text + attachments → the `content` the composer sends
 */

import type { ImagePartInput, PartInput } from "@shared/protocol-types";

/** Anthropic API only supports these image formats for vision. */
export const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export interface ImageAttachment {
  id: string;
  file: File;
  /** base64 data-URL for preview + for the API request body. */
  preview: string;
  type: string;
}

/** Convert image Files to base64 preview attachments via FileReader.
 *  Non-image files are silently filtered out. */
export async function processImageFiles(files: File[]): Promise<ImageAttachment[]> {
  const imageFiles = files.filter((f) => SUPPORTED_IMAGE_TYPES.has(f.type));
  if (!imageFiles.length) return [];
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
  return previews.filter((a): a is ImageAttachment => a != null);
}

/** Pull supported image files out of a clipboard paste event. */
export function extractImagesFromClipboard(e: React.ClipboardEvent): File[] {
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
}

/** Build canonical `image` PartInputs from attachments. Returns null when
 *  there are no images — the caller then sends plain text instead. */
export function buildImageParts(attachments: ImageAttachment[]): ImagePartInput[] | null {
  if (attachments.length === 0) return null;
  return attachments.map((attachment) => {
    const base64Data = attachment.preview.includes(",")
      ? attachment.preview.split(",")[1]
      : attachment.preview;
    return { type: "image" as const, data: base64Data, mimeType: attachment.type };
  });
}

/**
 * The composer's wire format: the canonical `PartInput` vocabulary, verbatim.
 *
 * Text-only sends stay a bare string — `AgentInput` is `string | PartInput[]`,
 * so a string IS canonical and the backend forwards it untouched. Attachments
 * promote the message to a JSON-encoded `PartInput[]`, which `toEngineInput`
 * hands straight to the engine. Inline XML (`<inspect>`, `<diff-comment>`)
 * lives INSIDE the text part and is parsed downstream — never here.
 */
export function buildMessageContent(text: string, attachments: ImageAttachment[]): string {
  const imageParts = buildImageParts(attachments);
  if (!imageParts) return text;

  const parts: PartInput[] = [];
  if (text) parts.push({ type: "text", text });
  parts.push(...imageParts);
  return JSON.stringify(parts);
}
