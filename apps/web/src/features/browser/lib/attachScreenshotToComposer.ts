/**
 * attachScreenshotToComposer — decode a PNG data URL captured from a
 * `<webview>` and push it onto a session's composer as an image attachment.
 *
 * Two call sites:
 *   - BrowserPanel's camera button (full-page screenshot)
 *   - InspectPromptOverlay's submit (region screenshot of a selected element)
 *
 * Returns true iff the image was attached. Swallows errors with a console
 * warning — screenshot failures are never fatal for the flow that called
 * us (the user's text and element metadata should still land in the chat).
 */

import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";
import { processImageFiles } from "@/features/session/lib/imageAttachments";

export async function attachScreenshotToComposer(
  sessionId: string,
  dataUrl: string | null,
  filenameLabel = "screenshot"
): Promise<boolean> {
  if (!dataUrl) return false;
  try {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/png" });
    const file = new File([blob], `browser-${filenameLabel}-${Date.now()}.png`, {
      type: "image/png",
    });
    const processed = await processImageFiles([file]);
    if (!processed.length) return false;
    sessionComposerActions.addImageAttachments(sessionId, processed);
    return true;
  } catch (err) {
    console.warn(`[browser] attachScreenshotToComposer failed (${filenameLabel}):`, err);
    return false;
  }
}
