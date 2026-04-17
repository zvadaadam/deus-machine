import { useSimStore } from "../stores/sim-store";
import { useProjectStore } from "../stores/project-store";
import { api } from "../lib/api";

export function TopBar() {
  const { sims, pinnedUdid, loading, setPinned } = useSimStore();
  const project = useProjectStore();
  const pinnedSim = sims.find((s) => s.udid === pinnedUdid);
  const booted = pinnedSim?.state === "Booted";

  const onBoot = async () => {
    if (!pinnedUdid) return;
    await api.boot(pinnedUdid);
    useSimStore.getState().refresh();
  };

  const onRun = async () => {
    if (!project.path || !project.scheme) return;
    project.setStatus("building");
    const buildRes = await api.build();
    if (!buildRes.success) {
      project.setStatus("failed");
      return;
    }
    project.setStatus("done");
  };

  const onProjectPath = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const path = e.target.value.trim();
    if (!path) return;
    await project.setProject(path);
  };

  return (
    <header className="topbar">
      <span className="brand">device-use</span>

      <label>
        <span className={`status-dot ${booted ? "ready" : ""}`} />
        <select
          value={pinnedUdid ?? ""}
          onChange={(e) => setPinned(e.target.value)}
          disabled={loading || sims.length === 0}
        >
          {sims.length === 0 && <option value="">no simulators</option>}
          {sims.map((s) => (
            <option key={s.udid} value={s.udid}>
              {s.state === "Booted" ? "● " : "○ "}
              {s.name} · {s.runtime}
            </option>
          ))}
        </select>
      </label>

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

      {project.schemes.length > 0 && (
        <select
          value={project.scheme ?? ""}
          onChange={(e) => project.setProject(project.path!, e.target.value)}
        >
          {project.schemes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}

      <span className="spacer" />

      <button
        className={`primary ${project.buildStatus === "building" ? "running" : ""}`}
        onClick={onRun}
        disabled={!project.path || !project.scheme || !booted || project.buildStatus === "building"}
      >
        {project.buildStatus === "building" ? "building…" : "▶ run"}
      </button>
    </header>
  );
}
