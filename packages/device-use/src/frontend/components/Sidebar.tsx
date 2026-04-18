import { useEffect } from "react";
import { ChevronRight, PanelRight } from "lucide-react";
import { useUiStore } from "../stores/ui-store";
import { ElementsPanel } from "./sidebar/ElementsPanel";
import { ActivityPanel } from "./sidebar/ActivityPanel";

/**
 * Sidebar wrapper — composes the Elements + Activity panels and handles
 * the collapsed/expanded state. When collapsed the sidebar disappears and
 * a thin rail button sits on the right edge to expand again. Cmd+B (or
 * Ctrl+B on non-Mac) toggles from anywhere.
 */
export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUiStore();

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "b") {
        ev.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  if (sidebarCollapsed) {
    return (
      <button
        className="sidebar-rail"
        onClick={toggleSidebar}
        title="Show sidebar (⌘B)"
        aria-label="Show sidebar"
      >
        <PanelRight size={14} />
      </button>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-chrome">
        <button
          className="sidebar-collapse"
          onClick={toggleSidebar}
          title="Hide sidebar (⌘B)"
          aria-label="Hide sidebar"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <ElementsPanel />
      <ActivityPanel />
    </aside>
  );
}
