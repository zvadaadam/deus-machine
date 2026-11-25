import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron } from "playwright";

const run = promisify(execFile);
const shim = fileURLToPath(new URL("./background-shim.cjs", import.meta.url));

export function launchInBackground({ args = [], ...options } = {}) {
  return _electron.launch({ ...options, args: ["--require", shim, ...args] });
}

// LaunchServices can read the active PID without activating an app.
async function frontmostPid() {
  const { stdout: asn } = await run("lsappinfo", ["front"]);
  const { stdout } = await run("lsappinfo", ["info", "-only", "pid", asn.trim()]);
  return Number(stdout.match(/pid = (\d+)/)?.[1]);
}

export function watchForeground() {
  const samples = [];
  const sample = () => samples.push(frontmostPid().catch(() => NaN));
  let timer;
  if (process.platform === "darwin") {
    sample();
    timer = setInterval(sample, 200);
  }
  return {
    async assertNeverFrontmost(pid) {
      if (!timer) return;
      clearInterval(timer);
      sample();
      const pids = await Promise.all(samples);
      const hits = pids.filter((front) => front === pid).length;
      const result = `Electron PID ${pid} was frontmost in ${hits} of ${pids.length} samples`;
      if (hits) throw new Error(result);
      if (!pids.every(Number.isInteger)) throw new Error("Could not read every frontmost PID");
      console.log(result);
    },
  };
}
