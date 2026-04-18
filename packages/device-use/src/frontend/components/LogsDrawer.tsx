import { useEffect, useRef, useState } from "react";
import { useLogsStore } from "../stores/logs-store";

export function LogsDrawer() {
  const { lines, clear } = useLogsStore();
  const [expanded, setExpanded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-expand whenever a new log line lands — if you were expecting output,
  // it pops open for you. Collapsing is always manual. We subscribe to the
  // store directly (outside effect body) so setState fires from a callback.
  useEffect(() => {
    let prev = useLogsStore.getState().lines.length;
    return useLogsStore.subscribe((state) => {
      if (state.lines.length > prev) setExpanded(true);
      prev = state.lines.length;
    });
  }, []);

  useEffect(() => {
    if (expanded) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines, expanded]);

  return (
    <section className={`logs ${expanded ? "expanded" : "collapsed"}`}>
      <button
        className="log-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        type="button"
      >
        <span className="log-header-left">
          <span className="log-chevron" aria-hidden>
            {expanded ? "▾" : "▸"}
          </span>
          logs {lines.length > 0 && `(${lines.length})`}
        </span>
        {expanded && lines.length > 0 && (
          <span
            className="clear-btn"
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                clear();
              }
            }}
          >
            clear
          </span>
        )}
      </button>
      {expanded && (
        <div className="log-body">
          {lines.length === 0 ? (
            <div style={{ color: "var(--text-muted-foreground)", fontStyle: "italic" }}>
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
        </div>
      )}
    </section>
  );
}
