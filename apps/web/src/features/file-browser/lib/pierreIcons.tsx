/**
 * Pierre icon utilities — lets non-tree UI (e.g. ChangesFilesPanel) render the
 * same VS Code file-type icons Pierre uses in the tree, without mounting a
 * Pierre tree.
 *
 * Design:
 *  - Pierre ships its sprite sheet as an SVG string containing <symbol>s.
 *    We inject it once into the main document (hidden) so any <use href=…>
 *    in the same document tree can reference the symbols.
 *  - createFileTreeIconResolver maps a file path → a sprite symbol + viewBox,
 *    handling byFileName / byFileExtension / byFileNameContains rules.
 *  - `colored: false` tells Pierre to treat all icons as `currentColor`, so
 *    the rendered icon takes its tint from the surrounding `color:` CSS.
 *  - We cache the resolver since it's pure, and dedupe the injection.
 */

import { useLayoutEffect } from "react";
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees";

const SPRITE_CONTAINER_ID = "deus-pierre-sprite";

const resolver = createFileTreeIconResolver({
  set: "standard",
  colored: false,
});

// Inject the sprite sheet into the main document exactly once. SVG `<use>`
// references resolve within the same document tree, so a hidden <div> that
// holds the sprite markup at the body level lets any component in the app
// reference its <symbol>s by id.
function ensureSpriteInjected(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(SPRITE_CONTAINER_ID)) return;

  const container = document.createElement("div");
  container.id = SPRITE_CONTAINER_ID;
  // Hidden but still parseable by the browser so the <symbol>s are discoverable.
  container.setAttribute(
    "style",
    "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none"
  );
  container.setAttribute("aria-hidden", "true");
  container.innerHTML = getBuiltInSpriteSheet("standard");
  document.body.appendChild(container);
}

interface PierreFileIconProps {
  fileName: string;
  /** Extra classes — the icon inherits `color` from its parent by default. */
  className?: string;
  /** Icon size in px. Defaults to 14 to match our dense file-row UI. */
  size?: number;
}

/**
 * Renders a Pierre VS Code file-type icon for a given filename. The SVG
 * `<use>` points to a <symbol> that lives in the sprite we inject into the
 * main document — no shadow DOM involved.
 */
export function PierreFileIcon({ fileName, className, size = 14 }: PierreFileIconProps) {
  useLayoutEffect(() => {
    ensureSpriteInjected();
  }, []);

  // `resolveIcon` looks up the right symbol for this path — TypeScript, JSON,
  // git, image, etc. — falling back to a generic file icon when no match.
  const icon = resolver.resolveIcon("file-tree-icon-file", fileName);
  const viewBox = icon.viewBox ?? "0 0 16 16";

  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#${icon.name}`} />
    </svg>
  );
}
