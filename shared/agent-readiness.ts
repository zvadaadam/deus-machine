import type { AgentAuthAnswer, HarnessAuth } from "./agent-auth";

type AgentReadiness =
  | { state: "ready"; auth: HarnessAuth; detail?: never }
  | { state: "signed_out"; auth: HarnessAuth; detail: string }
  | { state: "not_installed"; detail: string }
  | { state: "unknown"; status: "first-turn" | "install-failed" | "failed"; detail: string }
  | { state: "unknown"; status: "installing"; version?: string; percent?: number; detail: string };

/** A login can tell whether a turn will run only once the CLI is available. */
export function agentReadiness(
  answer: Pick<AgentAuthAnswer, "clis" | "auth">,
  harness: string
): AgentReadiness {
  const cli = answer.clis.find((row) => row.harness === harness);
  if (!cli) return { state: "unknown", status: "failed", detail: "Status unavailable" };
  if (cli.state === "installing") {
    const percent =
      cli.totalBytes && cli.receivedBytes !== undefined
        ? Math.floor((cli.receivedBytes / cli.totalBytes) * 100)
        : undefined;
    return {
      state: "unknown",
      status: "installing",
      version: cli.version,
      percent,
      detail: percent === undefined ? "installing" : `installing, ${percent}%`,
    };
  }
  if (cli.state === "failed" && cli.version) {
    const reason = cli.error ? `: ${cli.error}` : "";
    return {
      state: "unknown",
      status: "install-failed",
      detail: `its install failed${reason}; the next turn tries again`,
    };
  }
  if (cli.state !== "ready" && cli.state !== "unmanaged") {
    return cli.version
      ? { state: "unknown", status: "first-turn", detail: "installs with its first turn" }
      : { state: "not_installed", detail: cli.error || "Not available on this computer" };
  }

  const auth = answer.auth.find((row) => row.harness === harness);
  if (auth?.state === "signed_in") return { state: "ready", auth };
  if (auth?.state === "signed_out") {
    return { state: "signed_out", auth, detail: "sign in under Settings → AI Providers" };
  }
  return { state: "unknown", status: "failed", detail: auth?.error || "Status unavailable" };
}
