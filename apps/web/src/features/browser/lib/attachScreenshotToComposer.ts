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

import {
  attachImageFiles,
  type ComposerTarget,
} from "@/features/session/store/sessionComposerStore";

export async function attachScreenshotToComposer(
  target: ComposerTarget,
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
    return await attachImageFiles(target, [file]);
  } catch (err) {
    console.warn(`[browser] attachScreenshotToComposer failed (${filenameLabel}):`, err);
    return false;
  }
}
