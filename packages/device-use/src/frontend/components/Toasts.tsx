import { useActivityStore } from "../stores/activity-store";

export function Toasts() {
  const toasts = useActivityStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  const latest = toasts[toasts.length - 1];
  if (!latest) return null;

  return (
    <div className="toast">
      <strong>{latest.tool}</strong> {latest.status}
      {latest.error && (
        <span style={{ color: "var(--destructive)" }}> — {latest.error.slice(0, 80)}</span>
      )}
    </div>
  );
}
