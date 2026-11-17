// Signing this computer's GitHub CLI in and out, against a stub `gh` that
// records its arguments: the real one would change the person's sign-in.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ghLoginDone, logoutGh, startGhLogin } from "../../../src/services/gh-identity.service";

let dir: string;
const calls = () => readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");

/** A `gh` that logs each call and answers `auth login` with `login`'s shell lines. */
function stubGh(login: string) {
  const gh = path.join(dir, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$*" in
  "auth login"*) ${login} ;;
  "auth status"*) echo '{"hosts":{"github.com":[{"active":true,"login":"octo","state":"success"}]}}' ;;
esac
`
  );
  chmodSync(gh, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "deus-gh-sign-in-"));
  vi.stubEnv("DEUS_BUNDLED_BIN_DIR", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("GitHub CLI sign-in", () => {
  it("answers with gh's one-time code and page, then waits for gh to finish", async () => {
    stubGh(`echo "! One-time code (AB12-CD34) copied to clipboard" >&2
echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
sleep 0.2`);
    await expect(startGhLogin()).resolves.toEqual({
      code: "AB12-CD34",
      url: "https://github.com/login/device",
    });
    await expect(ghLoginDone()).resolves.toBeUndefined();
    expect(calls()).toEqual([
      "auth login --hostname github.com --git-protocol https --web --clipboard",
    ]);
  });

  it("says why when gh gives up", async () => {
    stubGh(`echo "error connecting to github.com" >&2; exit 1`);
    await expect(startGhLogin()).rejects.toThrow(
      "GitHub sign-in did not complete: error connecting to github.com"
    );
    await expect(ghLoginDone()).rejects.toThrow("did not complete");
  });

  it("signs out the active account", async () => {
    stubGh("true");
    await logoutGh();
    expect(calls().at(-1)).toBe("auth logout --hostname github.com --user octo");
  });
});
