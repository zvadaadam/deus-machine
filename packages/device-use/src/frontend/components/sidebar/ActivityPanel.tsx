import { useActivityStore } from "../../stores/activity-store";
import { Panel } from "./Panel";

export function ActivityPanel() {
  const events = useActivityStore((s) => s.events);

  return (
    <Panel title="activity">
      {events.length === 0 ? (
        <div className="sidebar-empty">no tool calls yet</div>
      ) : (
        events
          .slice(-30)
          .reverse()
          .map((e) => (
            <div key={`${e.id}-${e.status}`} className="activity-item">
              <span className="tool">{e.tool}</span>{" "}
              <span className={`status-${e.status}`}>{e.status}</span>
              {e.error && <div className="activity-error">{e.error}</div>}
            </div>
          ))
      )}
    </Panel>
  );
}
