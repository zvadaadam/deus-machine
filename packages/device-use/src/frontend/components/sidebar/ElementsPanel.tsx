import { useEffect } from "react";
import { useRefsStore } from "../../stores/refs-store";
import { useSimStore } from "../../stores/sim-store";
import { api } from "../../lib/api";
import { Panel } from "./Panel";

export function ElementsPanel() {
  const { refs, foreground, loading, refresh } = useRefsStore();
  const streamUdid = useSimStore((s) => s.streamInfo?.udid ?? null);

  // Refresh refs whenever the stream's UDID changes (initial connect or sim swap).
  useEffect(() => {
    if (!streamUdid) return;
    void useRefsStore.getState().refresh();
  }, [streamUdid]);

  const onRefClick = async (ref: string) => {
    await api.tap({ ref });
    useRefsStore.getState().scheduleRefresh();
  };

  return (
    <Panel
      title={
        <>
          elements
          {foreground && <span className="sidebar-panel-subtitle"> · {foreground}</span>}
        </>
      }
      action={
        <button
          className="sidebar-panel-action"
          onClick={refresh}
          disabled={loading}
          title="Take a fresh snapshot"
        >
          {loading ? "…" : "snapshot"}
        </button>
      }
    >
      {refs.length === 0 ? (
        <div className="sidebar-empty">
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
    </Panel>
  );
}
