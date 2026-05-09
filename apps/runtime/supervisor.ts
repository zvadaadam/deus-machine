import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

export type RuntimeProcessName = "agent-server" | "backend";

export interface RuntimeEntries {
  agentServerEntry: string;
  backendEntry: string;
  agentServerCwd: string;
  backendCwd: string;
}

export interface RuntimeProcessHooks {
  onStdoutLine?: (source: RuntimeProcessName, line: string) => void;
  onStderrLine?: (source: RuntimeProcessName, line: string) => void;
  onExit?: (source: RuntimeProcessName, code: number | null, signal: NodeJS.Signals | null) => void;
  onUnexpectedExit?: (
    source: RuntimeProcessName,
    code: number | null,
    signal: NodeJS.Signals | null
  ) => void;
}

export interface RuntimeSupervisorOptions {
  command: string;
  entries: RuntimeEntries;
  sharedEnv?: Record<string, string | undefined>;
  agentServerEnv?: Record<string, string | undefined>;
  backendEnv?: Record<string, string | undefined>;
  startupTimeoutMs?: number;
  forceElectronRunAsNode?: boolean;
  hooks?: RuntimeProcessHooks;
}

export interface RuntimeStartResult {
  agentServerUrl: string;
  backendPort: number;
}

interface ManagedProcess {
  child: ChildProcess;
  name: RuntimeProcessName;
}

function prettyProcessName(name: RuntimeProcessName): string {
  return name === "agent-server" ? "Agent server" : "Backend";
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

export class RuntimeSupervisor {
  private readonly opts: RuntimeSupervisorOptions;
  private readonly processes = new Map<RuntimeProcessName, ManagedProcess>();
  private stopping = false;

  constructor(opts: RuntimeSupervisorOptions) {
    this.opts = opts;
  }

  async start(): Promise<RuntimeStartResult> {
    await this.stop();
    this.stopping = false;

    const agentServerUrl = await this.startProcess({
      name: "agent-server",
      entry: this.opts.entries.agentServerEntry,
      cwd: this.opts.entries.agentServerCwd,
      env: {
        ...this.opts.sharedEnv,
        ...this.opts.agentServerEnv,
      },
      waitFor: /LISTEN_URL=(.+)/,
    });

    const backendPortValue = await this.startProcess({
      name: "backend",
      entry: this.opts.entries.backendEntry,
      cwd: this.opts.entries.backendCwd,
      env: {
        ...this.opts.sharedEnv,
        ...this.opts.backendEnv,
        AGENT_SERVER_URL: agentServerUrl,
      },
      waitFor: /^\[BACKEND_PORT\](\d+)$/,
    });

    return {
      agentServerUrl,
      backendPort: parseInt(backendPortValue, 10),
    };
  }

  async restart(): Promise<RuntimeStartResult> {
    await this.stop();
    return this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(
      Array.from(this.processes.values()).map(({ child }) => this.terminateProcess(child))
    );
    this.processes.clear();
  }

  private async startProcess(opts: {
    name: RuntimeProcessName;
    entry: string;
    cwd: string;
    env: Record<string, string | undefined>;
    waitFor: RegExp;
  }): Promise<string> {
    const { name, entry, cwd, env, waitFor } = opts;
    if (!existsSync(entry)) {
      throw new Error(`${prettyProcessName(name)} entry not found: ${entry}`);
    }

    mkdirSync(cwd, { recursive: true });

    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.command, [entry], {
        cwd,
        env: cleanEnv({
          ...process.env,
          ...(this.opts.forceElectronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          ...env,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.processes.set(name, { child, name });

      let settled = false;
      let stdoutBuffer = "";

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        fail(new Error(`${prettyProcessName(name)} startup timeout`));
      }, this.opts.startupTimeoutMs ?? 30_000);

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      const succeed = (value: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };

      child.stdout?.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.opts.hooks?.onStdoutLine?.(name, trimmed);

          const match = trimmed.match(waitFor);
          if (match) succeed(match[1]);
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.opts.hooks?.onStderrLine?.(name, trimmed);
        }
      });

      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        this.processes.delete(name);
        this.opts.hooks?.onExit?.(name, code, signal);

        if (!settled) {
          fail(new Error(`${prettyProcessName(name)} exited before starting (code=${code})`));
          return;
        }

        if (!this.stopping) {
          this.opts.hooks?.onUnexpectedExit?.(name, code, signal);
        }
      });

      child.on("error", (error) => {
        this.processes.delete(name);
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private terminateProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(forceTimer);
        resolve();
      };

      child.once("exit", finish);
      child.kill("SIGTERM");

      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 5_000);
    });
  }
}
