import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const START_TIMEOUT_MS = 10_000;
const START_POLL_MS = 100;

let browserProcess: ChildProcessWithoutNullStreams | null = null;
let browserBaseUrl: string | null = null;
let userDataDir: string | null = null;
let starting: Promise<string> | null = null;

export async function getManagedBrowserCdpBaseUrl(): Promise<string> {
  if (browserProcess && browserBaseUrl && !browserProcess.killed) {
    return browserBaseUrl;
  }
  if (starting) return starting;

  starting = startManagedBrowser().finally(() => {
    starting = null;
  });
  return starting;
}

async function startManagedBrowser(): Promise<string> {
  const chromePath = resolveChromePath();
  const port = await allocatePort();
  const dir = mkdtempSync(join(tmpdir(), "deus-managed-browser-"));
  userDataDir = dir;

  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "about:blank",
  ];

  browserProcess = spawn(chromePath, args, { stdio: "pipe" });
  browserProcess.once("exit", () => {
    browserProcess = null;
    browserBaseUrl = null;
    cleanupUserDataDir();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForCdp(baseUrl);
  browserBaseUrl = baseUrl;
  return baseUrl;
}

function resolveChromePath(): string {
  const configured = process.env.BROWSER_CHROME_PATH;
  if (configured) return configured;

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          ]
        : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

  for (const candidate of candidates) {
    try {
      if (candidate.includes("/") || candidate.includes("\\")) {
        execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 1000 });
        return candidate;
      }
      return execFileSync("which", [candidate], { encoding: "utf8", timeout: 1000 }).trim();
    } catch {
      // Try the next known browser binary.
    }
  }

  throw new Error(
    "No Chrome/Chromium binary found. Set BROWSER_CHROME_PATH to enable remote browser streaming."
  );
}

async function waitForCdp(baseUrl: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/json/version`);
      if (res.ok) return;
      lastError = new Error(`CDP returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(START_POLL_MS);
  }
  throw new Error(
    `Managed browser did not expose CDP: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("Failed to allocate managed browser CDP port"));
      });
    });
  });
}

function cleanupUserDataDir(): void {
  if (!userDataDir) return;
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; stale temp profiles are harmless and OS-cleaned.
  } finally {
    userDataDir = null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
