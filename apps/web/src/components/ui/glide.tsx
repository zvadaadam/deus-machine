import { useLayoutEffect, useRef } from "react";
import { cn } from "@/shared/lib/utils";

type GlideProps = { className: string; selected?: string } & (
  | { rows: string; follow?: never }
  | { rows?: never; follow: "data-highlighted" | "data-selected" | "aria-selected" }
);

/** Place inside a relative, isolated list. The caller supplies the row fill and radius. */
export function Glide({ rows, follow, selected, className }: GlideProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const fill = ref.current!;
    if (!fill.isConnected) return; // A closed Radix Select lives in a DocumentFragment.
    const list = (fill.offsetParent as HTMLElement | null) ?? fill.parentElement!;
    const { style } = fill;
    const marker =
      follow && (follow === "data-highlighted" ? "[data-highlighted]" : `[${follow}=true]`);
    let pointerTravel = false;
    let hovered: HTMLElement | null = null;
    let lit: HTMLElement | null = null;

    function clearIfFaded() {
      if (!lit && getComputedStyle(fill).opacity === "0") fill.removeAttribute("style");
    }

    function draw(reflow = false) {
      const row = marker ? list.querySelector<HTMLElement>(marker) : hovered;
      if (!row || !list.contains(row) || (selected && row.matches(selected))) {
        if (!lit) return;
        // Freeze interrupted travel at its painted position for the exit fade.
        const { transform, width, height } = getComputedStyle(fill);
        Object.assign(style, { transform, width, height });
        fill.removeAttribute("data-travel");
        fill.removeAttribute("data-lit");
        resize.unobserve(lit);
        lit = null;
        clearIfFaded(); // A fill that never became visible has no transitionend.
        return;
      }
      if (row === lit && !reflow) return;

      let x = row.offsetLeft;
      let y = row.offsetTop;
      let parent = row.offsetParent;
      while (parent instanceof HTMLElement && parent !== list) {
        x += parent.offsetLeft + parent.clientLeft;
        y += parent.offsetTop + parent.clientTop;
        parent = parent.offsetParent;
      }
      const transform = `translate(${x}px, ${y}px)`;
      const width = `${row.offsetWidth}px`;
      const height = `${row.offsetHeight}px`;
      if (
        row === lit &&
        transform === style.transform &&
        width === style.width &&
        height === style.height
      )
        return;

      // A return during the exit fade continues from the visible fill.
      const travel =
        !reflow &&
        pointerTravel &&
        row !== lit &&
        (lit !== null || Number(getComputedStyle(fill).opacity) > 0);
      fill.toggleAttribute("data-travel", travel);
      Object.assign(style, { transform, width, height });
      fill.setAttribute("data-lit", "");
      if (lit !== row) {
        if (lit) resize.unobserve(lit);
        resize.observe(row, { box: "border-box" });
        lit = row;
      }
    }

    function leave() {
      pointerTravel = false;
      hovered = null;
      if (rows) draw();
    }

    function pointer(event: PointerEvent) {
      pointerTravel = event.pointerType !== "touch";
      if (!rows) return; // In follow mode, the list owns its active row.
      if (!pointerTravel) return leave();
      const target = event.target;
      const hit = target instanceof Element && target.closest<HTMLElement>(rows);
      if (!hit || !list.contains(hit)) return; // Padding and gaps hold the previous row.
      hovered = hit;
      draw();
    }

    function keyboard() {
      pointerTravel = false;
    }
    const resize = new ResizeObserver(() => draw(true));
    const changes = new MutationObserver((records) => {
      draw(
        records.some((record) => record.type === "childList" || record.attributeName === "hidden")
      );
    });
    changes.observe(list, {
      subtree: true,
      childList: true,
      attributeFilter: [
        "hidden",
        ...(follow ? [follow] : []),
        ...(selected
          ? ["aria-current", "aria-selected", "aria-checked", "data-active", "data-state"]
          : []),
      ],
    });
    resize.observe(list);
    const listeners = new AbortController();
    const options = { capture: true, signal: listeners.signal };
    fill.addEventListener("transitionend", clearIfFaded, options);
    fill.addEventListener("transitioncancel", clearIfFaded, options);
    list.addEventListener("pointerover", pointer, options);
    list.addEventListener("pointerleave", leave, { signal: listeners.signal });
    if (follow) {
      list.addEventListener("pointermove", pointer, options);
      // cmdk keeps focus in the input, a sibling of the list.
      document.addEventListener("keydown", keyboard, options);
      draw();
    }
    return () => {
      listeners.abort();
      changes.disconnect();
      resize.disconnect();
      fill.removeAttribute("data-travel");
      fill.removeAttribute("data-lit");
      fill.removeAttribute("style");
    };
  }, [rows, follow, selected]);

  return (
    <span
      ref={ref}
      data-slot="glide"
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute top-0 left-0 -z-10 opacity-0 transition-opacity",
        "tempo-fast-exit data-[lit]:tempo-fast data-[lit]:opacity-100 motion-safe:data-[travel]:transition-[transform,width,height,opacity]",
        className
      )}
    />
  );
}
