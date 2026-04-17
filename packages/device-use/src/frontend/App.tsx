import { useEffect, useState } from "react";

type HealthResponse = { ok: boolean; uptime: number };

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    fetch("/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <main
      style={{
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        padding: "48px",
        color: "#111",
      }}
    >
      <h1 style={{ margin: 0 }}>device-use</h1>
      <p style={{ color: "#666", margin: "4px 0 32px" }}>v2 scaffold — Phase 1</p>
      <pre
        style={{
          background: "#f4f4f5",
          padding: "12px 16px",
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        {health ? JSON.stringify(health, null, 2) : "fetching /health..."}
      </pre>
    </main>
  );
}
