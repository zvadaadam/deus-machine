// `add_project`: an assistant puts a repository on this computer as a project.
// Runs the app's own clone and add (`api/repos.ts`) against a scratch SQLite
// database built from the fresh schema and a scratch home folder, with a
// stand-in `git` first on PATH: a clone is logged and made locally (`git init`
// and an origin), never fetched; every other git command is the real git's.
// Nothing reaches the network or the person's own folders.

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatorError } from "@zvada/agent-server/operator";
import type { AnyOp } from "@shared/api/op";
import { CATALOG_MODEL_LISTS } from "@shared/models";
import { SCHEMA_SQL } from "@shared/schema";

const state = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
  /** Stand-ins for the operations that are not the repositories'. */
  ops: {} as Record<string, (input: Record<string, unknown>) => unknown>,
  run: null as unknown as (op: { name: string; kind: string }, input: unknown) => Promise<unknown>,
  stored: {} as Record<string, string>,
  report: vi.fn(),
  uuid: 0,
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: () => state.db }));
vi.mock("../../../src/services/query-engine", () => ({
  runAsThisComputer: (op: AnyOp, input: Record<string, unknown>) => {
    const standIn = state.ops[op.name];
    return standIn ? Promise.resolve(standIn(input ?? {})) : state.run(op, input);
  },
  onInvalidate: () => () => {},
  invalidate: vi.fn(),
}));
vi.mock("../../../src/services/server-name", () => ({ getServerName: () => "Proof Mac" }));
vi.mock("@sentry/node", () => ({ captureException: state.report }));
vi.mock("../../../src/services/agent/service", () => ({
  provideSessionTools: () => {},
}));
vi.mock("../../../src/services/settings.service", () => ({ getSetting: () => undefined }));
vi.mock("../../../src/services/streams", () => ({ publish: vi.fn() }));
vi.mock("../../../src/services/account-session", () => ({
  currentAccountSession: () => ({ accountId: "user_a", cloudUrl: "https://cloud.test" }),
}));
vi.mock("../../../src/services/remote-machine.service", () => ({
  getMachineId: () => "0123456789abcdef",
}));
vi.mock("../../../src/services/assistants/store", () => ({
  findAssistant: (_host: unknown, clientId: string) =>
    state.stored[clientId] ? { clientId, access: state.stored[clientId] } : undefined,
}));
// What `api/repos.ts` reaches besides git, the database and the folders: none of it runs here.
vi.mock("../../../src/services/cloud-workspace-init.service", () => ({
  resolveCloudRepoAccess: vi.fn(),
}));
vi.mock("../../../src/services/workspace-checkout", async (read) => ({
  ...(await read<typeof import("../../../src/services/workspace-checkout")>()),
  initializeWorkspace: vi.fn(),
}));
vi.mock("../../../src/services/agent/cloud/config", () => ({ defaultCloudOrgId: () => null }));
vi.mock("../../../src/services/cloud-settings.service", () => ({ listAccessibleRepos: vi.fn() }));
vi.mock("../../../src/services/github-remote", () => ({
  defaultBranch: vi.fn(),
  branches: vi.fn(),
}));
vi.mock("../../../src/services/gh.service", () => ({
  runGh: vi.fn(),
  parseGitHubRepo: vi.fn(),
}));
vi.mock("../../../src/services/project-environment.service", () => ({
  readProjectFile: vi.fn(),
  writeProjectFile: vi.fn(),
}));
vi.mock("../../../src/services/recent-projects.service", () => ({ listRecentProjects: vi.fn() }));
vi.mock("@shared/lib/uuid", () => ({ uuidv7: () => `repo-${++state.uuid}` }));

import { LOCAL_CALLER, Registry, type Caller } from "../../../src/api/registry";
import handlers from "../../../src/api/assistants";
import repoHandlers from "../../../src/api/repos";
import * as api from "@shared/api/assistants";
import { _resetOperator } from "../../../src/services/assistants/operator";
import { NOT_ALLOWED_YET, READ_ONLY } from "../../../src/services/assistants/sentences";
import { homeRelative } from "../../../src/services/assistants/home-relative";
import { CLONE_REFUSALS } from "../../../src/lib/clone-address";
import { AppError, ConflictError } from "../../../src/lib/errors";
import { assistantCaller as assistant, operations } from "../../helpers";

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const ORIGINAL = { HOME: process.env.HOME, PATH: process.env.PATH };

let scratch: string;
let home: string;
let developer: string;
/** One line per clone: its arguments, NUL-free, separated by a tab. */
let cloneLog: string;
/** A clone of an address with "slow" (or "Slow") in it waits until this file exists. */
let release: string;

/** The stand-in git: clones are logged and made locally; everything else is the real git. */
function writeFakeGit(bin: string) {
  const script = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = clone ]; then
    printf '%s\\t' "$@" >> "${cloneLog}"
    printf '\\n' >> "${cloneLog}"
    for last; do :; done
    url=""
    prev=""
    for arg2 in "$@"; do
      if [ "$arg2" = "$last" ]; then url="$prev"; fi
      prev="$arg2"
    done
    echo "Cloning into '$last'..." >&2
    case "$url" in
      *missing*)
        echo "cannot write to '$last'." >&2
        echo "remote: Repository not found." >&2
        echo "fatal: repository '$url/' not found" >&2
        exit 128 ;;
      *wrong-origin*) url="https://github.com/elsewhere/widget" ;;
      *slow*|*Slow*)
        i=0
        while [ ! -e "${release}" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done ;;
    esac
    "${REAL_GIT}" init -q -b main "$last" && "${REAL_GIT}" -C "$last" remote add origin "$url"
    exit $?
  fi
done
exec "${REAL_GIT}" "$@"
`;
  const file = path.join(bin, "git");
  fs.writeFileSync(file, script, { mode: 0o755 });
}

/** The clones git was asked for: each one's arguments. */
function clones(): string[][] {
  if (!fs.existsSync(cloneLog)) return [];
  return fs
    .readFileSync(cloneLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").filter(Boolean));
}

/** A folder holding a git repository whose origin is `origin`, made by the real git. */
function gitFolder(folder: string, origin?: string) {
  fs.mkdirSync(folder, { recursive: true });
  execFileSync(REAL_GIT, ["init", "-q", "-b", "main", folder]);
  if (origin) execFileSync(REAL_GIT, ["-C", folder, "remote", "add", "origin", origin]);
}

function insertProject(name: string, root: string | null, origin: string | null) {
  state.db
    .prepare(
      `INSERT INTO repositories (id, name, root_path, git_default_branch, sort_order, git_origin_url)
       VALUES (?, ?, ?, 'main', (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM repositories), ?)`
    )
    .run(`seed-${name}`, name, root, origin);
}

function projects() {
  return state.db
    .prepare("SELECT name, root_path, git_origin_url FROM repositories ORDER BY sort_order")
    .all() as { name: string; root_path: string | null; git_origin_url: string | null }[];
}

/** What the MCP binding answers: a tool list, or a tool's text (an error when it is a refusal). */
interface McpReply {
  result: {
    tools: { name: string; description: string }[];
    content: { text: string }[];
    isError?: boolean;
  };
}

const mcp = (message: unknown, caller: Caller = LOCAL_CALLER) =>
  operations(handlers, caller)(api.agentMcp, { message }) as Promise<McpReply>;

/** One tools/call: the text the model reads, or a rejection carrying it when it is an error. */
async function callTool(caller: Caller, name: string, args: Record<string, unknown> = {}) {
  const reply = await mcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    caller
  );
  const text = reply.result.content[0]!.text;
  expect.soft(text).not.toContain(home);
  if (reply.result.isError) throw new Error(text);
  return text;
}

const addProject = (repository: string, caller: Caller = LOCAL_CALLER) =>
  callTool(caller, "add_project", { repository });

/** A caller whose connection is cut in `seconds`: its held calls answer a few seconds before. */
const ending = (seconds: number): Caller => ({
  ...assistant(),
  endsAt: Date.now() + seconds * 1000,
});

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deus-add-project-")));
  const bin = path.join(scratch, "bin");
  fs.mkdirSync(bin);
  cloneLog = path.join(scratch, "clones.log");
  release = path.join(scratch, "release");
  writeFakeGit(bin);
  process.env.PATH = `${bin}:${ORIGINAL.PATH}`;
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
});

afterAll(() => {
  vi.unstubAllEnvs();
  process.env.HOME = ORIGINAL.HOME;
  process.env.PATH = ORIGINAL.PATH;
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(scratch, "home-"));
  developer = path.join(home, "Developer");
  process.env.HOME = home;
  fs.rmSync(cloneLog, { force: true });
  fs.rmSync(release, { force: true });
  state.uuid = 0;
  state.stored = { claude: "operate" };
  state.db = new Database(":memory:");
  state.db.exec(SCHEMA_SQL);
  const registry = new Registry(repoHandlers);
  state.run = (op, input) =>
    registry.run(op.name, op.kind as never, input, { caller: LOCAL_CALLER });
  state.ops = {
    agentModels: ({ harness }) => ({
      lists: CATALOG_MODEL_LISTS.filter((list) => !harness || list.harness === harness),
    }),
  };
  _resetOperator();
});

afterEach(() => {
  state.db.close();
  vi.clearAllMocks();
});

describe("who may run it", () => {
  it("is listed for every caller, as a write that reaches past this computer", async () => {
    const lists = await Promise.all(
      [LOCAL_CALLER, assistant("pending"), assistant("read"), assistant()].map(
        async (caller) =>
          (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, caller)).result.tools
      )
    );
    for (const list of lists) expect(list).toEqual(lists[0]);
    const tool = lists[0]!.find((t) => t.name === "add_project")!;
    expect(tool).toMatchObject({
      title: "Add project",
      annotations: { readOnlyHint: false, openWorldHint: true },
    });
    expect(tool.description).toContain("start_session");
  });

  it("is refused to an assistant allowed to read, or not allowed yet, before git or the disk", async () => {
    await expect(addProject("acme/widget", assistant("read"))).rejects.toThrow(READ_ONLY);
    await expect(addProject("acme/widget", assistant("pending"))).rejects.toThrow(NOT_ALLOWED_YET);
    expect(clones()).toEqual([]);
    expect(fs.existsSync(developer)).toBe(false);
  });

  it("is refused, just before the clone, to one admitted to operate but lowered to read since", async () => {
    state.stored.claude = "read";
    await expect(addProject("acme/widget", assistant("operate"))).rejects.toThrow(READ_ONLY);
    expect(clones()).toEqual([]);
    expect(fs.existsSync(developer)).toBe(false);
    expect(projects()).toEqual([]);
  });

  it("runs for an operating assistant and for this computer's window", async () => {
    await expect(addProject("acme/widget", assistant())).resolves.toContain("cloned");
    await expect(addProject("acme/gadget", LOCAL_CALLER)).resolves.toContain("cloned");
    expect(clones()).toHaveLength(2);
  });
});

describe("the address", () => {
  it.each([
    ["acme/widget", "https://github.com/acme/widget", "widget"],
    ["https://github.com/acme/gadget.git", "https://github.com/acme/gadget.git", "gadget"],
    ["git@github.com:acme/sprocket.git", "git@github.com:acme/sprocket.git", "sprocket"],
    ["ssh://git@git.example.com/acme/cog", "ssh://git@git.example.com/acme/cog", "cog"],
  ])("%s reaches git as one argument after --", async (given, url, name) => {
    const answer = await addProject(given);
    const [args] = clones();
    const folder = path.join(developer, name);
    expect(args!.slice(args!.indexOf("--"))).toEqual(["--", url, folder]);
    expect(args).not.toContain("--recurse-submodules");
    expect(answer).toBe(
      `cloned ${JSON.stringify(url)} into "~/Developer/${name}" and added it as the project ${JSON.stringify(name)}.\n` +
        `  -> start_session(project: ${JSON.stringify(name)}, message: "<the first task>")`
    );
  });

  it.each([
    ["/Users/someone/widget", CLONE_REFUSALS.form],
    ["file:///Users/someone/widget", CLONE_REFUSALS.form],
    ["ext::sh -c touch% /tmp/pwned", CLONE_REFUSALS.characters],
    ["ext::sh%20-c%20touch", CLONE_REFUSALS.form],
    ["git://github.com/acme/widget", CLONE_REFUSALS.form],
    ["http://github.com/acme/widget", CLONE_REFUSALS.http],
    ["acme/wid get", CLONE_REFUSALS.characters],
    ["acme/wid\u0000get", CLONE_REFUSALS.characters],
    ["--upload-pack=touch /tmp/pwned", CLONE_REFUSALS.characters],
    ["-uacme/widget", CLONE_REFUSALS.dash],
    ["acme/..", CLONE_REFUSALS.name],
  ])("%j is refused before git runs", async (given, why) => {
    await expect(addProject(given)).rejects.toThrow(`${why} Nothing was cloned.`);
    expect(clones()).toEqual([]);
    expect(fs.existsSync(developer)).toBe(false);
  });

  it("with a credential in it is refused in words that do not repeat it", async () => {
    const refused = addProject("https://someone:ghp_SECRETtoken@github.com/acme/widget");
    await expect(refused).rejects.toThrow(CLONE_REFUSALS.credential);
    await expect(refused).rejects.not.toThrow(/SECRET|someone/);
    expect(clones()).toEqual([]);
  });
});

describe("what is already here", () => {
  it("shows the home as ~ and leaves other folders with similar names alone", () => {
    expect(homeRelative(home)).toBe("~");
    const sibling = home + "-backup/Developer/widget";
    expect(homeRelative(sibling)).toBe(sibling);
    expect(homeRelative(`${home}/one, ${home}/two, ${sibling}`, "diagnostic")).toBe(
      `~/one, ~/two, ${sibling}`
    );
    const elsewhere = path.join("/Volumes/archive", home, "widget");
    expect(homeRelative(elsewhere)).toBe(elsewhere);
    const diagnostic = `Cannot open '${elsewhere}'.`;
    expect(homeRelative(diagnostic, "diagnostic")).toBe(diagnostic);
  });

  it("abbreviates the exact home in a git diagnostic and preserves quoted sibling names", () => {
    const diagnostic = `fatal: repository '${home}' missing; checked "${home}/repo" and '${home} backup'`;
    expect(homeRelative(diagnostic, "diagnostic")).toBe(
      `fatal: repository '~' missing; checked "~/repo" and '${home} backup'`
    );
    expect(homeRelative(`cannot open ${home}`, "diagnostic")).toBe("cannot open ~");
  });

  it("a project for that repository is returned, and nothing is cloned", async () => {
    const folder = path.join(home, "code", "widget");
    insertProject("widget", folder, "git@github.com:acme/widget.git");
    const answer = await addProject("https://github.com/acme/widget");
    expect(answer).toBe(
      `"widget" is already a project on this computer, in "~/code/widget". Nothing was cloned.\n` +
        `  -> start_session(project: "widget", message: "<the first task>")`
    );
    expect(clones()).toEqual([]);
    expect(projects()).toHaveLength(1);
  });

  it("a folder that is that repository's clone is added, and nothing is cloned", async () => {
    const folder = path.join(developer, "widget");
    gitFolder(folder, "https://github.com/acme/widget.git");
    const answer = await addProject("git@github.com:acme/widget.git");
    expect(answer).toContain(`added "widget" from "~/Developer/widget"`);
    expect(answer).toContain("Nothing was cloned.");
    expect(clones()).toEqual([]);
    expect(projects()).toEqual([
      { name: "widget", root_path: folder, git_origin_url: "https://github.com/acme/widget.git" },
    ]);
  });

  it.each([
    ["not a git repository", (folder: string) => fs.mkdirSync(folder, { recursive: true })],
    ["different origin", (folder: string) => gitFolder(folder, "https://github.com/other/widget")],
    ["no origin", (folder: string) => gitFolder(folder)],
    [
      "inside another repository",
      (folder: string) => {
        gitFolder(developer, "https://github.com/acme/widget");
        fs.mkdirSync(folder);
      },
    ],
    [
      "does not exist or is inaccessible",
      (folder: string) => {
        fs.mkdirSync(developer, { recursive: true });
        fs.symlinkSync(path.join(home, "nowhere"), folder);
      },
    ],
  ] as const)("explains why the existing folder cannot be adopted: %s", async (reason, make) => {
    make(path.join(developer, "widget"));
    await expect(addProject("acme/widget")).rejects.toThrow(reason);
    expect(clones()).toEqual([]);
    expect(projects()).toEqual([]);
  });

  it("a clone whose folder differs only in case is added, on a disk that does not tell them apart", async () => {
    fs.mkdirSync(developer, { recursive: true });
    const probe = path.join(developer, "CaseProbe");
    fs.mkdirSync(probe);
    const caseInsensitive = fs.existsSync(path.join(developer, "caseprobe"));
    fs.rmdirSync(probe);
    if (!caseInsensitive) return;
    const folder = path.join(developer, "widget");
    gitFolder(folder, "https://github.com/acme/Widget.git");
    const answer = await addProject("acme/Widget");
    expect(answer).toContain("Nothing was cloned.");
    expect(clones()).toEqual([]);
    expect(projects()).toHaveLength(1);
  });

  it("a project with no folder here gets the clone as its folder: one row, not two", async () => {
    insertProject("widget", null, "https://github.com/acme/widget");
    const answer = await addProject("acme/widget");
    expect(answer).toContain('added it as the project "widget"');
    expect(projects()).toEqual([
      {
        name: "widget",
        root_path: path.join(developer, "widget"),
        git_origin_url: "https://github.com/acme/widget",
      },
    ]);
  });

  it("adds a matching clone even when a legacy blank project has the same origin", async () => {
    const origin = "https://github.com/acme/widget";
    const folder = path.join(developer, "widget");
    gitFolder(folder, origin);
    state.db.exec("DROP TRIGGER validate_project_insert");
    insertProject("", "", origin);
    state.db.exec(SCHEMA_SQL);

    expect(await addProject("acme/widget")).toContain(`added "widget" from "~/Developer/widget"`);
    expect(projects()).toEqual([
      { name: "", root_path: "", git_origin_url: origin },
      { name: "widget", root_path: folder, git_origin_url: origin },
    ]);
    expect(clones()).toEqual([]);
  });
});

describe("the same folder added meanwhile (H18)", () => {
  it("by the person while the tool clones: the start hint names their registered project", async () => {
    // The app's add answers 409 with the project the folder already is (another add won).
    state.ops.addRepo = ({ root_path }) => {
      insertProject("Widget on disk", root_path as string, "https://github.com/acme/widget");
      return state.run({ name: "addRepo", kind: "write" }, { root_path });
    };
    const said = await addProject("acme/widget");
    expect(said).toContain('start_session(project: "Widget on disk"');
  });
});

describe("a clone", () => {
  it("reports the refusal reason and gives the clone retry hint once", async () => {
    const reason = "The folder could not be registered.";
    const next = '-> add_project(repository: "acme/widget")';
    state.ops.addRepo = () => {
      throw new OperatorError("unsupported", `${reason} See ${developer}.`, { next });
    };
    await expect(addProject("acme/widget")).rejects.toMatchObject({
      message: `refused (unsupported): Cloned into "~/Developer/widget", but could not add the project. ${reason} See ~/Developer.\n  ${next}`,
    });
  });

  it.each(["inspectRepo", "addRepo"])(
    "reports the clone left on disk when %s fails",
    async (op) => {
      const folder = path.join(developer, "widget");
      state.ops[op] = () => {
        throw new ConflictError("The folder could not be registered.");
      };
      await expect(addProject("acme/widget")).rejects.toThrow(
        `Cloned into "~/Developer/widget", but could not add the project. The folder could not be registered.\n  -> add_project(`
      );
      expect(fs.existsSync(path.join(folder, ".git"))).toBe(true);
      delete state.ops[op];
      expect(await addProject("acme/widget")).toContain("Nothing was cloned.");
      expect(clones()).toHaveLength(1);
    }
  );

  it.each([new Error("private database detail"), new AppError(500, "private service detail")])(
    "leaves an unexpected $name to the operator and adopts the clone on retry",
    async (failure) => {
      state.ops.addRepo = () => {
        throw failure;
      };
      const answer = await addProject("acme/widget");
      expect(answer).toContain("not confirmed");
      expect(answer).not.toContain(failure.message);
      delete state.ops.addRepo;
      expect(await addProject("acme/widget")).toContain("Nothing was cloned.");
      expect(clones()).toHaveLength(1);
    }
  );

  it("checks a fresh clone's origin before adding it", async () => {
    await expect(addProject("acme/wrong-origin")).rejects.toThrow("different origin");
    expect(projects()).toEqual([]);
  });

  it("refuses an add that returned a different folder", async () => {
    state.ops.addRepo = () => ({
      id: "wrong",
      name: "Widget",
      root_path: path.join(developer, "other"),
    });
    await expect(addProject("acme/widget")).rejects.toThrow(
      "did not register the inspected folder"
    );
  });

  it("refuses a legacy blank name even when the registered folder matches", async () => {
    state.ops.addRepo = () => ({
      name: "",
      root_path: fs.realpathSync(path.join(developer, "widget")),
    });
    await expect(addProject("acme/widget")).rejects.toThrow(
      "did not register the inspected folder"
    );
  });

  it.each([
    ["internal-path/private-repo", /internal-path|private-repo/],
    ["https://user:TOKEN@github.com/other/widget", /TOKEN|other\/widget/],
  ] as const)("keeps the different origin %s out of the refusal", async (origin, privateText) => {
    gitFolder(path.join(developer, "widget"), origin);
    const result = addProject("acme/widget");
    await expect(result).rejects.toThrow("different origin");
    await expect(result).rejects.not.toThrow(privateText);
    expect(projects()).toEqual([]);
  });

  it("that fails answers with git's words quoted, and adds nothing", async () => {
    await expect(addProject("acme/missing")).rejects.toThrow(
      'could not clone "https://github.com/acme/missing". Nothing was added. git said:\n' +
        "  | cannot write to '~/Developer/missing'.\n" +
        "  | remote: Repository not found.\n" +
        "  | fatal: repository 'https://github.com/acme/missing/' not found"
    );
    expect(projects()).toEqual([]);
    expect(fs.existsSync(path.join(developer, "missing"))).toBe(false);
    // Heard once: the next call tries again.
    await expect(addProject("acme/missing")).rejects.toThrow("could not clone");
    expect(clones()).toHaveLength(2);
  });

  it("still running at the caller's limit is said so; a second call joins it, and one after it ends hears the outcome", async () => {
    const first = await addProject("acme/slow", ending(7));
    expect(first).toBe(
      `still cloning "https://github.com/acme/slow" into "~/Developer/slow". Call add_project again with the same repository for the outcome; nothing is cloned twice.\n` +
        '  -> add_project(repository: "acme/slow")'
    );
    // Another form of the same address joins the clone in flight.
    const second = await addProject("git@github.com:acme/slow.git", ending(7));
    expect(second).toContain("still cloning");
    // A short call can return before the child has scheduled its first write.
    await vi.waitFor(() => expect(clones()).toHaveLength(1), { timeout: 5000 });

    fs.writeFileSync(release, "");
    const third = await addProject("acme/slow", assistant());
    expect(third).toContain(`cloned "https://github.com/acme/slow" into "~/Developer/slow"`);
    expect(clones()).toHaveLength(1);
    expect(projects()).toHaveLength(1);
    // Heard: the next call finds the project.
    await expect(addProject("acme/slow")).resolves.toContain("is already a project");
  }, 15_000);

  it("in flight refuses another repository that would take the same folder", async () => {
    await addProject("acme/slow", ending(7));
    await expect(addProject("other/slow", ending(7))).rejects.toThrow(
      `The folder "~/Developer/slow" is being cloned for another repository.`
    );
    fs.writeFileSync(release, "");
    await expect(addProject("acme/slow")).resolves.toContain("cloned");
    expect(clones()).toHaveLength(1);
  }, 15_000);

  it("in flight is joined by the same repository named in another case: one folder, one clone", async () => {
    const first = await addProject("acme/Slow", ending(7));
    expect(first).toContain("still cloning");
    const second = await addProject("acme/slow", ending(7));
    expect(second).toContain("still cloning");
    fs.writeFileSync(release, "");
    await expect(addProject("acme/Slow")).resolves.toContain("cloned");
    expect(clones()).toHaveLength(1);
  }, 15_000);

  it("asked twice at once by the same caller clones once", async () => {
    const [a, b] = await Promise.all([addProject("acme/widget"), addProject("acme/widget")]);
    expect(a).toBe(b);
    expect(clones()).toHaveLength(1);
    expect(projects()).toHaveLength(1);
  });
});

describe("then start_session", () => {
  it("finds the project by the name the answer gives", async () => {
    const answer = await addProject("acme/widget", assistant());
    const name = /start_session\(project: "([^"]+)"/.exec(answer)![1]!;
    const started = await callTool(assistant(), "start_session", {
      project: name,
      message: "Add a test",
      wait: 0,
    });
    expect(started).toContain('in "widget"');
  });
});

describe("projects with no folder on this computer", () => {
  it("starting a session in one is refused with how to put it here", async () => {
    insertProject("widget", null, "https://github.com/acme/widget");
    insertProject("gadget", path.join(home, "gadget"), null);
    await expect(
      callTool(assistant(), "start_session", { project: "widget", message: "go", wait: 0 })
    ).rejects.toThrow(
      'refused (unsupported): "widget" is a cloud project: it has no folder on this computer, so no session can start here. Nothing was started; add_project puts it on this computer.\n' +
        '  -> add_project(repository: "acme/widget")'
    );
  });
});
