/**
 * ItemIcon — the tile beside every app, plugin and skill: the brand mark in
 * its own colours (shared/integrations/icons.ts, generated from SVG Logos and
 * Simple Icons), or the item's initial when it has none. Brand colours are
 * content and live only in that generated file; the tile, its border and the
 * fallbacks stay tokens.
 */

import { useId, useMemo, type ComponentType, type CSSProperties, type SVGAttributes } from "react";
import {
  INTEGRATION_ICON_ID,
  INTEGRATION_ICONS,
  type IntegrationIcon,
} from "@shared/integrations/icons";
import { cn } from "@/shared/lib/utils";

interface ItemIconProps {
  icon?: string;
  name: string;
  /** A lucide glyph for items without a brand (skills, custom servers). */
  fallback?: ComponentType<SVGAttributes<SVGSVGElement>>;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const TILE = { sm: "h-7 w-7 rounded-md", md: "h-9 w-9 rounded-lg", lg: "h-12 w-12 rounded-xl" };
const GLYPH = { sm: "h-3.5 w-3.5", md: "h-[18px] w-[18px]", lg: "h-6 w-6" };
const LETTER = { sm: "text-xs", md: "text-sm", lg: "text-lg" };

/**
 * A mark's `currentColor` is the brand's ink, except in the theme whose tile
 * would swallow it (GitHub's black on the dark tile): there it stays the
 * tile's text colour. The generator decides which theme that is.
 */
const INK = {
  everywhere: "text-(color:--ink)",
  dark: "text-(color:--ink) dark:text-inherit",
  light: "dark:text-(color:--ink)",
};

/**
 * One drawn copy of a generated mark. Its markup comes only from the generated
 * file; the ids in it (gradients, masks) are made this copy's own, because a
 * page shows the same mark many times and the first copy's ids would win.
 */
function Mark({ mark, className }: { mark: IntegrationIcon; className: string }) {
  const id = useId();
  const body = useMemo(
    () => mark.body.replaceAll(INTEGRATION_ICON_ID, `mark-${id.replace(/\W/g, "")}-`),
    [mark.body, id]
  );
  return (
    <svg
      viewBox={mark.viewBox}
      className={cn(className, mark.ink && INK[mark.textColorIn ?? "everywhere"])}
      style={mark.ink ? ({ "--ink": mark.ink } as CSSProperties) : undefined}
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

export function ItemIcon({
  icon,
  name,
  fallback: Fallback,
  size = "md",
  className,
}: ItemIconProps) {
  const brand = icon ? INTEGRATION_ICONS[icon] : undefined;
  return (
    <span
      aria-hidden
      className={cn(
        "border-border-subtle bg-bg-elevated text-text-primary flex shrink-0 items-center justify-center border",
        TILE[size],
        className
      )}
    >
      {brand ? (
        <Mark mark={brand} className={GLYPH[size]} />
      ) : Fallback ? (
        <Fallback className={cn(GLYPH[size], "text-text-secondary")} />
      ) : (
        <span className={cn("text-text-secondary font-semibold", LETTER[size])}>
          {name.trim().charAt(0).toUpperCase() || "?"}
        </span>
      )}
    </span>
  );
}

/**
 * A plugin's tile: the marks of its first apps, so a bundle reads as what it
 * brings together. Falls back to a package glyph for skill-only bundles.
 */
export function PluginIcon({
  icons,
  name,
  size = "md",
  fallback,
}: {
  icons: Array<string | undefined>;
  name: string;
  size?: "md" | "lg";
  fallback?: ComponentType<SVGAttributes<SVGSVGElement>>;
}) {
  // One mark per brand: Figma's remote and desktop servers share one.
  const marks = [...new Set(icons)].flatMap((icon) =>
    icon && INTEGRATION_ICONS[icon] ? [{ icon, mark: INTEGRATION_ICONS[icon] }] : []
  );
  const [first, second] = marks;
  if (!first) return <ItemIcon name={name} size={size} fallback={fallback} />;
  // A bundle around one app wears that app's mark, whole.
  if (!second) return <ItemIcon icon={first.icon} name={name} size={size} />;
  const shown = marks.slice(0, 4);
  return (
    <span
      aria-hidden
      className={cn(
        // Tracks as wide as the marks, so the cluster sits in the tile's centre.
        "border-border-subtle bg-bg-elevated text-text-secondary grid shrink-0 grid-cols-[auto_auto] place-content-center border",
        TILE[size],
        size === "lg" ? "gap-1" : "gap-0.5"
      )}
    >
      {shown.map(({ icon, mark }) => (
        <Mark
          key={icon}
          mark={mark}
          className={size === "lg" ? "h-[15px] w-[15px]" : "h-[11px] w-[11px]"}
        />
      ))}
    </span>
  );
}
