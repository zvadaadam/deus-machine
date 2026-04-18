import { useSimStore } from "../stores/sim-store";
import { useProjectStore } from "../stores/project-store";
import { useActivityStore } from "../stores/activity-store";
import { api } from "../lib/api";
import { Select } from "./Select";

export function TopBar() {
  const { sims, pinnedUdid, loading, setPinned } = useSimStore();
  const project = useProjectStore();
  const pinnedSim = sims.find((s) => s.udid === pinnedUdid);
  const booted = pinnedSim?.state === "Booted";

  const onBoot = async () => {
    if (!pinnedUdid) return;
    const res = await api.boot(pinnedUdid);
    if (!res.success) {
      // Surface boot failures via the activity store's toast channel.
      useActivityStore.getState().push({
        type: "tool-event",
        id: res.id ?? `boot-${Date.now()}`,
        at: Date.now(),
        tool: "boot",
        params: { udid: pinnedUdid },
        status: "failed",
        error: res.error ?? "boot failed",
      });
    }
    useSimStore.getState().refresh();
  };

  const onRun = async () => {
    if (!project.path || !project.scheme) return;
    project.setStatus("running");
    // `run` is the composite: build → install → launch.
    const res = await api.run();
    project.setStatus(res.success ? "done" : "failed");
  };

  const onProjectPath = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const path = e.target.value.trim();
    if (!path) return;
    await project.setProject(path);
  };

  const simOptions = sims.map((s) => ({
    value: s.udid,
    label: (
      <span>
        <span className="sim-state-dot" data-booted={s.state === "Booted" ? "true" : "false"} />
        {s.name}
        <span className="sim-runtime"> · {s.runtime}</span>
      </span>
    ),
  }));

  return (
    <header className="topbar">
      <span className="brand">device-use</span>

      <span className="sim-picker">
        <span className={`status-dot ${booted ? "ready" : ""}`} />
        {sims.length === 0 ? (
          <span className="sim-empty">no simulators</span>
        ) : (
          <Select
            value={pinnedUdid ?? ""}
            onValueChange={setPinned}
            options={simOptions}
            disabled={loading}
            placeholder="Pick a simulator"
            minWidth={220}
          />
        )}
      </span>

      {pinnedUdid && !booted && (
        <button onClick={onBoot} title="Boot this simulator">
          boot
        </button>
      )}

      <input
        type="text"
        placeholder="project path (.xcodeproj or .xcworkspace)"
        defaultValue={project.path ?? ""}
        onBlur={onProjectPath}
        style={{ minWidth: 280 }}
      />

      {project.schemes.length > 0 && project.path && (
        <Select
          value={project.scheme ?? ""}
          onValueChange={(scheme) => project.setProject(project.path!, scheme)}
          options={project.schemes.map((s) => ({ value: s, label: s }))}
          placeholder="Pick a scheme"
          minWidth={140}
        />
      )}

      <span className="spacer" />

      <button
        className={`primary ${project.buildStatus === "running" ? "running" : ""}`}
        onClick={onRun}
        disabled={!project.path || !project.scheme || !booted || project.buildStatus === "running"}
      >
        {project.buildStatus === "running" ? "running…" : "▶ run"}
      </button>
    </header>
  );
}
