/**
 * Dashboard-specific error fallback UI
 * Shown when the Dashboard component crashes
 */
export function DashboardError() {
  const handleReload = () => {
    window.location.href = "/";
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        padding: "2rem",
        backgroundColor: "var(--bg-primary)",
      }}
    >
      <div style={{ maxWidth: "500px", textAlign: "center" }}>
        <div style={{ fontSize: "64px", marginBottom: "1rem" }}>📊</div>
        <h2 style={{ fontSize: "24px", fontWeight: 600, marginBottom: "1rem" }}>Dashboard Error</h2>
        <p style={{ color: "var(--text-secondary)", marginBottom: "2rem" }}>
          The dashboard encountered an error while loading your workspaces. This might be a
          temporary issue.
        </p>
        <button
          onClick={handleReload}
          style={{
            padding: "0.75rem 1.5rem",
            backgroundColor: "var(--primary)",
            color: "var(--primary-foreground)",
            border: "none",
            borderRadius: "6px",
            fontSize: "14px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Reload Dashboard
        </button>
      </div>
    </div>
  );
}
