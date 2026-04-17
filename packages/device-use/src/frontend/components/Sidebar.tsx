import { useState } from "react";
import { useActivityStore } from "../stores/activity-store";
import { api } from "../lib/api";

interface Ref {
  ref: string;
  label?: string;
  type?: string;
  identifier?: string;
}

export function Sidebar() {
  const events = useActivityStore((s) => s.events);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  const onSnapshot = async () => {
    setSnapshotLoading(true);
    try {
      const res = await api.snapshot();
      if (res.success && res.result) {
        setRefs(res.result.refs as Ref[]);
      }
    } finally {
      setSnapshotLoading(false);
    }
  };

  const onRefClick = async (ref: string) => {
    await api.tap({ ref });
  };

  return (
    <aside className="sidebar">
      <div className="section" style={{ flex: 1 }}>
        <div className="section-header">
          <span>elements</span>
          <button
            className="clear-btn"
            style={{ fontSize: 10, padding: "2px 6px" }}
            onClick={onSnapshot}
            disabled={snapshotLoading}
          >
            {snapshotLoading ? "…" : "snapshot"}
          </button>
        </div>
        <div className="section-body">
          {refs.length === 0 ? (
            <div className="empty">click snapshot to load a11y tree</div>
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
