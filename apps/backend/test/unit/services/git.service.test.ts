import { describe, expect, it } from "vitest";
import { parseDiffFiles, resolveWorkspaceRelativePath } from "../../../src/services/git.service";

describe("parseDiffFiles", () => {
  const header = (status: string) => `:100644 100644 0000000 abcdef0 ${status}`;
  const raw = (status: string, ...paths: string[]) => [header(status), ...paths].join("\0");

  const rows = (records: string[]) =>
    Array.from(parseDiffFiles(records.join("\0")).values(), ({ change }) => change);

  it("takes paths by position, even when a path looks like a raw record or contains tabs and newlines", () => {
    const old = header("D");
    const file = "1\t2\tline\nbreak\t";
    const records = [
      raw("R085", old, file),
      raw("M", ":other"),
      `2\t1\t\0${old}\0${file}`,
      "-\t-\t:other",
      "",
    ];
    expect(rows(records)).toEqual([
      { file, previous_path: old, status: "renamed", additions: 2, deletions: 1 },
      { file: ":other", status: "modified", additions: 0, deletions: 0 },
    ]);
  });

  it("takes both paths of a copy and reports copies, type changes and unmerged entries as modified", () => {
    const records = [
      raw("C100", "source", "copy"),
      raw("T", "link"),
      raw("U", "conflict"),
      "0\t0\t\0source\0copy",
      "1\t2\tlink",
      "3\t0\tconflict",
      "",
    ];
    expect(rows(records)).toEqual([
      { file: "copy", status: "modified", additions: 0, deletions: 0 },
      { file: "link", status: "modified", additions: 1, deletions: 2 },
      { file: "conflict", status: "modified", additions: 3, deletions: 0 },
    ]);
  });

  it("accepts a clean working tree", () => {
    expect(parseDiffFiles("").size).toBe(0);
  });

  it("keeps one row for repeated unmerged paths and takes counts with only a numstat path", () => {
    const records = [
      raw("D", "gone"),
      raw("U", "gone"),
      raw("U", "edited"),
      raw("M", "edited"),
      "0\t1\tgone",
      "0\t0\tgone",
      "3\t0\tedited",
      "0\t2\tedited",
      "1\t2\tother",
      "",
    ];
    expect(rows(records)).toEqual([
      { file: "gone", status: "deleted", additions: 0, deletions: 1 },
      { file: "edited", status: "modified", additions: 3, deletions: 2 },
      { file: "other", status: "modified", additions: 1, deletions: 2 },
    ]);
  });

  it.each([
    header("M") + "\0",
    [header("R100"), "source", ""].join("\0"),
    "1\t0\t\0source\0",
    "1\t0\tfile",
    "unknown record\0",
  ])("rejects an incomplete or malformed record %j", (record) => {
    expect(() => parseDiffFiles(record)).toThrow();
  });
});

describe("resolveWorkspaceRelativePath", () => {
  it.each(["src/file.ts", "..notes", "folder/new name.txt"])("accepts %s", (file) => {
    expect(resolveWorkspaceRelativePath("/workspace", file)).toBe(file);
  });

  it.each(["../../etc/passwd", "/etc/passwd", "file\0.ts", "", ".", null])("refuses %j", (file) => {
    expect(resolveWorkspaceRelativePath("/workspace", file)).toBeNull();
  });
});
