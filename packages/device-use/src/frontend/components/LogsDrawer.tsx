import { useEffect, useRef } from "react";
import { useLogsStore } from "../stores/logs-store";

export function LogsDrawer() {
  const { lines, clear } = useLogsStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines]);

  return (
    <section className="logs">
      <div className="log-header">
        <span>logs {lines.length > 0 && `(${lines.length})`}</span>
        <button className="clear-btn" onClick={clear}>
          clear
        </button>
      </div>
      {lines.length === 0 ? (
        <div style={{ color: "var(--dim)", fontStyle: "italic" }}>
          nothing yet — build logs and simulator app logs appear here
        </div>
      ) : (
        lines.map((l, i) => (
          <div key={i} className={`log-line ${l.stream}`}>
            {l.text}
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </section>
  );
}
