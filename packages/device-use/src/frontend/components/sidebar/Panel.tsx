import type { ReactNode } from "react";

/** Reusable sidebar panel — title row + optional header action + scrollable body.
 *  Used by ElementsPanel and ActivityPanel; keeps the Sidebar wrapper small. */
export interface PanelProps {
  /** Left-aligned uppercase title (e.g. "elements"). */
  title: ReactNode;
  /** Right-aligned header content (usually a button or a status badge). */
  action?: ReactNode;
  /** Flex weight within the sidebar (default 1). */
  flex?: number;
  /** Body content — scrollable region. */
  children: ReactNode;
}

export function Panel({ title, action, flex = 1, children }: PanelProps) {
  return (
    <div className="sidebar-panel" style={{ flex }}>
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">{title}</span>
        {action}
      </div>
      <div className="sidebar-panel-body">{children}</div>
    </div>
  );
}
