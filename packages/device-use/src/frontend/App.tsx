import { useEffect } from "react";
import "./styles.css";
import { TopBar } from "./components/TopBar";
import { DeviceFrame } from "./components/DeviceFrame";
import { Sidebar } from "./components/Sidebar";
import { LogsDrawer } from "./components/LogsDrawer";
import { Toasts } from "./components/Toasts";
import { useEventsWs } from "./lib/ws";
import { useSimStore } from "./stores/sim-store";
import { useProjectStore } from "./stores/project-store";

export function App() {
  useEventsWs();

  useEffect(() => {
    useSimStore.getState().refresh();
    useProjectStore.getState().refresh();
    // Refresh sim list every 10s (catches external simctl boot/shutdown).
    const t = setInterval(() => useSimStore.getState().refresh(), 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="app">
      <TopBar />
      <DeviceFrame />
      <Sidebar />
      <LogsDrawer />
      <Toasts />
    </div>
  );
}
