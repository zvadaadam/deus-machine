import { useEffect } from "react";
import { useActivityStore } from "../stores/activity-store";
import { useRefsStore } from "../stores/refs-store";
import { useSimStore } from "../stores/sim-store";
import { api } from "../lib/api";

export function Sidebar() {
  const events = useActivityStore((s) => s.events);
  const { refs, foreground, loading, refresh } = useRefsStore();
  const streamInfo = useSimStore((s) => s.streamInfo);

  // Take an initial snapshot once the stream is live.
  useEffect(() => {
    if (streamInfo && refs.length === 0) {
      void useRefsStore.getState().refresh();
    }
  }, [streamInfo, refs.length]);

  const onRefClick = async (ref: string) => {
    await api.tap({ ref });
    useRefsStore.getState().scheduleRefresh(500);
  };

  return (
    <aside className="sidebar">
      <div className="section" style={{ flex: 1 }}>
        <div className="section-header">
          <span>
            elements
            {foreground && (
              <span
                style={{
                  marginLeft: 8,
                  color: "var(--accent-2)",
                  textTransform: "none",
                  letterSpacing: 0,
                }}
              >
                · {foreground}
              </span>
            )}
          </span>
          <button
            className="clear-btn"
            style={{ fontSize: 10, padding: "2px 6px" }}
            onClick={refresh}
            disabled={loading}
          >
            {loading ? "…" : "snapshot"}
          </button>
        </div>
        <div className="section-body">
          {refs.length === 0 ? (
            <div className="empty">
              {loading ? "loading…" : "no interactive elements on this screen"}
            </div>
          ) : (
            refs.map((r) => (
              <div key={r.ref} className="ref-item" onClick={() => onRefClick(r.ref)}>
                <span className="ref-id">{r.ref}</span>
                <span className="ref-label">{r.label || r.identifier || "—"}</span>{" "}
                <span className="ref-type">{r.type}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="section" style={{ flex: 1 }}>
        <div className="section-header">
          <span>activity</span>
        </div>
        <div className="section-body">
          {events.length === 0 ? (
            <div className="empty">no tool calls yet</div>
          ) : (
            events
              .slice(-30)
              .reverse()
              .map((e) => (
                <div key={`${e.id}-${e.status}`} className="activity-item">
                  <span className="tool">{e.tool}</span>{" "}
                  <span className={`status-${e.status}`}>{e.status}</span>
                  {e.error && <div style={{ color: "var(--danger)", marginTop: 2 }}>{e.error}</div>}
                </div>
              ))
          )}
        </div>
      </div>
    </aside>
  );
}
