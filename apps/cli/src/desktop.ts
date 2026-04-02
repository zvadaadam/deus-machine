/**
 * Desktop installer — downloads and installs the Electron desktop app.
 *
 * Fetches the latest release from GitHub, downloads the appropriate installer
 * for the current platform, and runs it.
 */

import { execSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform, arch, homedir } from "node:os";
import { get } from "node:https";
import { IncomingMessage } from "node:http";
import {
  spinner as createSpinner,
  progressBar,
  progressBarDone,
  c,
  blank,
  success,
  error,
  hint,
  kv,
} from "./ui.js";
import { formatBytes } from "./lib/format.js";

const GITHUB_REPO = "zvadaadam/box-ide";

const INSTALL_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/Deus.app", `${homedir()}/Applications/Deus.app`],
  win32: [
    `${process.env.LOCALAPPDATA || ""}\\Programs\\Deus\\Deus.exe`,
    `${process.env.PROGRAMFILES || ""}\\Deus\\Deus.exe`,
  ],
  linux: [`${homedir()}/.local/bin/Deus.AppImage`, "/usr/local/bin/Deus.AppImage"],
};

export interface DesktopOptions {
  version: string;
}

interface GithubRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

/** Check if a display/GUI is available. */
export function hasDisplay(): boolean {
  const os = platform();
  if (process.env.CI || process.env.DOCKER || existsSync("/.dockerenv")) return false;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (os === "darwin") return true;
  if (os === "win32") return true;
  if (os === "linux") return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return false;
}

/** Check if the desktop app is already installed. */
export function findInstalledApp(): string | null {
  const os = platform();
  const paths = INSTALL_PATHS[os] || [];
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/** Launch an already-installed desktop app. */
export function launchDesktop(appPath: string): void {
  const os = platform();
  switch (os) {
    case "darwin":
      spawn("open", [appPath], { detached: true, stdio: "ignore" }).unref();
      break;
    case "win32":
    case "linux":
      spawn(appPath, [], { detached: true, stdio: "ignore" }).unref();
      break;
  }
}

export async function installDesktop(options: DesktopOptions): Promise<void> {
  const { version } = options;
  const os = platform();
  const cpuArch = arch();

  // Determine which asset to download
  const assetPattern = getAssetPattern(os, cpuArch);
  if (!assetPattern) {
    error(`Unsupported platform: ${os} ${cpuArch}`);
    blank();
    hint("Supported: macOS (arm64/x64), Windows (x64), Linux (x64)");
    hint(`Or run ${c.cyan("deus start")} to run as a headless server.`);
    blank();
    process.exit(1);
  }

  kv("Platform", `${os} ${cpuArch}`, 10);
  kv("Package", c.dim(assetPattern.description), 10);
  blank();

  // Fetch release info
  const s1 = createSpinner("Fetching latest release...");
  const release = await fetchRelease(version);

  if (!release) {
    s1.fail("Could not find a release on GitHub");
    blank();
    hint(`Repo: ${c.dim(GITHUB_REPO)}`);
    hint("Make sure the repository has published releases.");
    hint(`Or run ${c.cyan("deus start")} to run as a headless server.`);
    blank();
    process.exit(1);
  }

  s1.succeed(`Found release ${c.cyan(release.tag_name)}`);

  // Find matching asset
  const asset = release.assets.find((a) => assetPattern.matcher(a.name));
  if (!asset) {
    error(`No matching installer for ${os} ${cpuArch}`);
    blank();
    hint("Available downloads:");
    for (const a of release.assets) {
      hint(`  ${a.name}`);
    }
    blank();
    process.exit(1);
  }

  // Download
  const downloadDir = join(tmpdir(), "deus-installer");
  mkdirSync(downloadDir, { recursive: true });
  const downloadPath = join(downloadDir, asset.name);

  await downloadFile(asset.browser_download_url, downloadPath);

  // Install
  const s3 = createSpinner("Installing...");
  const installed = await installForPlatform(os, downloadPath, s3);

  // Cleanup temp file
  try {
    unlinkSync(downloadPath);
  } catch {
    // ignore cleanup failure
  }

  if (installed) {
    blank();
    success("Deus is ready!");
    blank();
  }
}

function getAssetPattern(
  os: string,
  cpuArch: string
): { matcher: (name: string) => boolean; description: string } | null {
  switch (os) {
    case "darwin": {
      const archSuffix = cpuArch === "arm64" ? "arm64" : "x64";
      return {
        matcher: (name) => name.endsWith(".dmg") && name.includes(archSuffix),
        description: `macOS DMG (${archSuffix})`,
      };
    }
    case "win32":
      return {
        matcher: (name) => name.endsWith(".exe") && !name.includes("blockmap"),
        description: "Windows installer (exe)",
      };
    case "linux":
      return {
        matcher: (name) => name.endsWith(".AppImage"),
        description: "Linux AppImage",
      };
    default:
      return null;
  }
}

async function fetchRelease(version: string): Promise<GithubRelease | null> {
  const endpoint =
    version === "latest"
      ? `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
      : `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${version}`;

  const TIMEOUT = 30_000;
  return new Promise((resolve) => {
    const req = get(
      endpoint,
      { headers: { "User-Agent": "deus-cli", Accept: "application/vnd.github.v3+json" } },
      (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          const loc = res.headers.location;
          if (loc) {
            const req2 = get(loc, { headers: { "User-Agent": "deus-cli" } }, (r) => {
              collectBody(r).then((b) => {
                try {
                  resolve(JSON.parse(b));
                } catch {
                  resolve(null);
                }
              });
            });
            req2.setTimeout(TIMEOUT, () => req2.destroy());
            req2.on("error", () => resolve(null));
            return;
          }
        }
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        collectBody(res).then((b) => {
          try {
            resolve(JSON.parse(b));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.setTimeout(TIMEOUT, () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

function collectBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    res.on("data", (chunk: Buffer) => (body += chunk.toString()));
    res.on("end", () => resolve(body));
    res.on("error", () => resolve(""));
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const download = (downloadUrl: string) => {
      const req = get(downloadUrl, { headers: { "User-Agent": "deus-cli" } }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          const loc = res.headers.location;
          res.resume(); // consume redirect response to free socket
          if (loc) {
            download(loc);
            return;
          }
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }

        const totalSize = parseInt(res.headers["content-length"] || "0", 10);
        let downloaded = 0;

        const file = createWriteStream(dest);
        res.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
          if (totalSize > 0) {
            progressBar(
              downloaded,
              totalSize,
              formatBytes(downloaded) + " / " + formatBytes(totalSize)
            );
          }
        });
        res.pipe(file);
        file.on("close", () => {
          progressBarDone(`Downloaded ${c.dim(formatBytes(totalSize))}`);
          resolve();
        });
        file.on("error", reject);
      });
      req.setTimeout(120_000, () => req.destroy(new Error("Download timed out")));
      req.on("error", reject);
    };

    download(url);
  });
}

async function installForPlatform(
  os: string,
  filePath: string,
  s: ReturnType<typeof createSpinner>
): Promise<boolean> {
  switch (os) {
    case "darwin": {
      try {
        const mountOutput = execSync(`hdiutil attach "${filePath}" -nobrowse`, {
          encoding: "utf-8",
        });

        const mountPoint = mountOutput
          .split("\n")
          .filter((line) => line.includes("/Volumes/"))
          .map((line) => line.trim().split("\t").pop()?.trim())
          .find(Boolean);

        if (!mountPoint) {
          s.fail("Could not mount disk image");
          return false;
        }

        const appName = "Deus.app";
        const appPath = `${mountPoint}/${appName}`;
        const destPath = `/Applications/${appName}`;

        if (existsSync(appPath)) {
          execSync(`rm -rf "${destPath}"`, { stdio: "pipe" });
          execSync(`cp -R "${appPath}" "${destPath}"`, { stdio: "pipe" });
          s.succeed(`Installed to ${c.dim("/Applications/Deus.app")}`);

          launchDesktop(destPath);
        } else {
          s.warn("DMG mounted — drag Deus to Applications to finish");
        }

        execSync(`hdiutil detach "${mountPoint}" -quiet`, { stdio: "pipe" });
        return true;
      } catch {
        s.fail("Auto-install failed — opening DMG manually");
        execSync(`open "${filePath}"`);
        return false;
      }
    }

    case "win32": {
      s.succeed("Launching installer...");
      spawn(filePath, [], { detached: true, stdio: "ignore" }).unref();
      hint("Follow the on-screen instructions to complete installation.");
      return true;
    }

    case "linux": {
      try {
        execSync(`chmod +x "${filePath}"`);
        const installDir = join(homedir(), ".local", "bin");
        mkdirSync(installDir, { recursive: true });
        const destPath = join(installDir, "Deus.AppImage");
        execSync(`cp "${filePath}" "${destPath}"`);
        s.succeed(`Installed to ${c.dim(destPath)}`);

        launchDesktop(destPath);
        return true;
      } catch {
        s.fail("Installation failed — check permissions");
        return false;
      }
    }

    default:
      s.fail("Unsupported platform");
      return false;
  }
}
