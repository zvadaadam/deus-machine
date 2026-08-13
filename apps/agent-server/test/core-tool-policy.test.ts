// The edit-guard's path resolution: new (not-yet-existing) files must resolve
// through symlinks — the deepest-existing-ancestor walk — or a write through
// an in-workspace symlink escapes the workspace, and a workspace that itself
// sits behind a symlink (macOS /tmp) false-denies every new file.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideToolUse } from "../agents/core/tool-policy";
import { trackedSessions } from "../session-tracker";

const SID = "policy-test-session";
let workspace: string;
let outside: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "deus-ws-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "deus-outside-"));
  fs.symlinkSync(outside, path.join(workspace, "evil-link"));
  trackedSessions.set(SID, { harness: "claude-code", cwd: workspace });
});

afterAll(() => {
  trackedSessions.delete(SID);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const edit = (filePath: string) =>
  decideToolUse("Write", { file_path: filePath, content: "x" }, {
    sessionId: SID,
    toolCallId: "tc",
  } as never);

describe("edit guard path resolution", () => {
  it("denies a NEW file written through an in-workspace symlink pointing outside", async () => {
    const result = await edit(path.join(workspace, "evil-link", "new-file.ts"));
    expect(result?.behavior).toBe("deny");
  });

  it("denies an EXISTING file behind the symlink", async () => {
    fs.writeFileSync(path.join(outside, "existing.ts"), "y");
    const result = await edit(path.join(workspace, "evil-link", "existing.ts"));
    expect(result?.behavior).toBe("deny");
  });

  it("allows a new file in a symlinked WORKSPACE root (macOS /tmp)", async () => {
    // workspace lives under os.tmpdir(), which on macOS is itself behind a
    // symlink (/tmp -> /private/tmp) — the allowed-dir and the target must
    // both canonicalize for the prefix check to hold.
    const result = await edit(path.join(workspace, "brand-new.ts"));
    expect(result?.behavior).toBe("allow");
  });

  it("allows a new file in a not-yet-created subdirectory", async () => {
    const result = await edit(path.join(workspace, "deep", "er", "new.ts"));
    expect(result?.behavior).toBe("allow");
  });

  it("denies relative traversal out of the workspace", async () => {
    const result = await edit("../outside-rel.ts");
    expect(result?.behavior).toBe("deny");
  });
});
