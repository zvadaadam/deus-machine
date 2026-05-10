// packages/pencil/src/lib/editor-bundle.ts
//
// Resolves the Pencil editor bundle (HTML + JS + WASM) we serve at /editor.
// Source priority:
//   1. Cloud (canonical): hit api.pencil.dev/public/versions, download the
//      ZIP from Vercel Blob Storage on first run, cache by version.
//   2. Cursor / VS Code globalStorage (the Pencil extension already
//      caches a copy on the same machine).
//   3. Stale local cache as a last resort.
//
// Cloud is preferred: any user with Deus + a CLI key can use the AAP, no
// other Pencil software required.

import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import { join } from "node:path";
import * as unzipper from "unzipper";

const PENCIL_VERSION_MANIFEST_URL = "https://api.pencil.dev/public/versions";
const EDITOR_CACHE_ROOT = join(os.homedir(), ".deus", "pencil-editor");

interface VersionManifest {
  version: string;
  minimumExtensionVersion: string;
  downloadUrl: string;
  cliVersion: string;
}

/** Resolve a usable editor-bundle directory (containing index.html + assets/). */
export async function ensureEditorBundle(): Promise<string> {
  try {
    return await ensureLatestVersionCached();
  } catch (err) {
    console.warn(`[pencil-aap] cloud bundle unavailable: ${(err as Error).message}`);
  }
  const local = findLocalEditorBundle();
  if (local) {
    console.log(`[pencil-aap] using local editor bundle: ${local}`);
    return local;
  }
  const cached = newestCachedVersion();
  if (cached) {
    const dir = join(EDITOR_CACHE_ROOT, cached);
    console.log(`[pencil-aap] using stale cached editor bundle: ${dir}`);
    return dir;
  }
  throw new Error("could not locate Pencil editor bundle (offline + no local install)");
}

async function ensureLatestVersionCached(): Promise<string> {
  fs.mkdirSync(EDITOR_CACHE_ROOT, { recursive: true });
  const manifest = await fetchJson<VersionManifest>(PENCIL_VERSION_MANIFEST_URL);
  if (!manifest.version || !manifest.downloadUrl) {
    throw new Error("pencil version manifest missing version or downloadUrl");
  }
  const target = join(EDITOR_CACHE_ROOT, manifest.version);
  if (fs.existsSync(join(target, "index.html"))) {
    console.log(`[pencil-aap] cached editor bundle: ${target} (v${manifest.version})`);
    return target;
  }
  console.log(
    `[pencil-aap] downloading editor bundle v${manifest.version} (this only happens once per version)…`
  );
  await downloadAndUnzip(manifest.downloadUrl, EDITOR_CACHE_ROOT, manifest.version);
  console.log(`[pencil-aap] cached editor bundle: ${target}`);
  return target;
}

function newestCachedVersion(): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(EDITOR_CACHE_ROOT);
  } catch {
    return null;
  }
  const versions = entries
    .filter((d) => /^\d+\.\d+\.\d+/.test(d))
    .filter((d) => fs.existsSync(join(EDITOR_CACHE_ROOT, d, "index.html")))
    .sort((a, b) => semverCompare(b, a));
  return versions[0] ?? null;
}

function semverCompare(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function findLocalEditorBundle(): string | null {
  const HOME = os.homedir();
  const candidates = [
    join(HOME, "Library/Application Support/Cursor/User/globalStorage/highagency.pencildev/editor"),
    join(HOME, "Library/Application Support/Code/User/globalStorage/highagency.pencildev/editor"),
    join(HOME, ".config/Code/User/globalStorage/highagency.pencildev/editor"),
    join(HOME, ".config/Cursor/User/globalStorage/highagency.pencildev/editor"),
  ];
  return candidates.find((p) => fs.existsSync(join(p, "index.html"))) ?? null;
}

// ---- HTTP helpers ---------------------------------------------------------

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch (err) {
          reject(new Error(`invalid JSON from ${url}: ${(err as Error).message}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout fetching ${url}`)));
    req.on("error", reject);
  });
}

function downloadStream(url: string, destPath: string, redirectsLeft = 3): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl: string): void => {
      const req = https.get(currentUrl, { timeout: 60_000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error(`too many redirects fetching ${url}`));
          redirectsLeft--;
          return attempt(res.headers.location ?? "");
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", (err) => fs.unlink(destPath, () => reject(err)));
      });
      req.on("timeout", () => req.destroy(new Error(`timeout fetching ${url}`)));
      req.on("error", reject);
    };
    attempt(url);
  });
}

async function downloadAndUnzip(url: string, cacheRoot: string, version: string): Promise<void> {
  const tmpZip = join(cacheRoot, `${version}.tmp.zip`);
  const tmpDir = join(cacheRoot, `${version}.tmp`);
  const finalDir = join(cacheRoot, version);
  try {
    await downloadStream(url, tmpZip);
    fs.mkdirSync(tmpDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(tmpZip)
        .pipe(unzipper.Extract({ path: tmpDir }))
        .on("close", resolve)
        .on("error", reject);
    });
    const extracted = join(tmpDir, "out");
    if (!fs.existsSync(join(extracted, "index.html"))) {
      throw new Error("editor bundle ZIP did not contain out/index.html");
    }
    if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(extracted, finalDir);
  } finally {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
  }
}

// ---- HTML rewriter --------------------------------------------------------

/** Serve the editor's index.html with a `<script>` injected before its
 *  module entry that flips the IPC factory into "webappapi" mode. The
 *  iframe parent then bridges postMessage IPC to our backend. */
export function rewriteEditorIndex(html: string): string {
  const inject = `
    <script>
      // Pencil editor in webappapi mode — TEe() in the bundle reads this
      // and switches IPC to window.parent.postMessage. The parent (Deus's
      // iframe wrapper) forwards messages to /ipc + /events.
      window.webappapi = {
        getBasePath() { return "/editor/"; }
      };
      // Deus handles auth with the CLI-key setup card in the parent frame.
      // The bundled editor may still render its own email OTP modal when it
      // rejects a CLI key as a web token; remove only that modal so the
      // CLI-authenticated canvas stays usable.
      (() => {
        const hideEditorSignin = () => {
          const headings = Array.from(document.querySelectorAll("h1,h2,h3"));
          for (const heading of headings) {
            if ((heading.textContent || "").trim() !== "Sign in to Pencil") continue;
            let node = heading.parentElement;
            while (node && node !== document.body) {
              const style = window.getComputedStyle(node);
              if (style.position === "fixed" && node.textContent?.includes("Email Address")) {
                node.remove();
                return;
              }
              node = node.parentElement;
            }
          }
        };
        new MutationObserver(hideEditorSignin).observe(document.documentElement, {
          childList: true,
          subtree: true
        });
        window.addEventListener("DOMContentLoaded", hideEditorSignin);
        window.setTimeout(hideEditorSignin, 0);
      })();
    </script>
  `;
  return html.replace(/<script[^>]*type="module"[^>]*>/, (m) => inject + m);
}
