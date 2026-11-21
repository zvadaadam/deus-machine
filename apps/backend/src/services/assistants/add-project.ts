// backend/src/services/assistants/add-project.ts
// `add_project`: put a repository on this computer as a project, so
// `start_session` can start work in it. The app's own clone does it
// (`gitClone`, then `addRepo`, through the host's `act`), into the folder its
// "Clone from GitHub" uses by default (`~/Developer/<name>`). The caller names
// the repository and nothing else: the address is checked by the clone's own
// rule (`lib/clone-address.ts`), and the folder comes from the repository's
// name.
//
// A clone can outlast a call. Each folder (by its lower-cased path: the disk
// may not tell `App` from `app`) has at most one add in flight: a
// call for the same repository joins it, and one that sees it end answers its
// outcome. When the call's deadline (the package's `CallScope`) nears it
// says it is still cloning; the outcome is then kept for the next call (30 minutes), which
// reports it. A project that is already here is returned with nothing cloned.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { OperatorError, callHint, quote, quoted, tool } from "@zvada/agent-server/operator";
import * as repos from "@shared/api/repos";
import type { Repository } from "@shared/types/repository";
import type { Caller } from "../../api/registry";
import {
  parseCloneAddress,
  projectsFolder,
  repositoryKey,
  type CloneAddress,
} from "../../lib/clone-address";
import { AppError, ConflictError } from "../../lib/errors";
import type { DeusHost, Who } from "./host";

/** A call answers "still cloning" this long before its deadline, so the answer arrives. */
const ANSWER_MARGIN_MS = 1000;

/** An outcome no call has heard is kept this long for the next call. */
const UNHEARD_KEPT_MS = 30 * 60_000;

type Added = { how: "here" | "adopted" | "cloned"; name: string; folder: string };

function registered(how: Added["how"], repo: Repository, folder: string): Added {
  if (!repo.name || repo.root_path !== folder)
    throw new OperatorError(
      "failed",
      "Deus did not register the inspected folder. Check the project on this computer."
    );
  return { how, name: repo.name, folder: repo.root_path };
}

/** One folder's add: being checked, cloned or added, then its outcome until a call hears it. */
interface Flight {
  address: CloneAddress;
  phase: "checking" | "cloning" | "cloned";
  done: Promise<Added>;
  outcome?: { added: Added } | { error: unknown };
  settledAt?: number;
}

/** The project's name as `start_session` takes it, and where it is. */
function answerFor(address: CloneAddress, added: Added): string {
  const { how } = added;
  const name = quoted(added.name);
  const where = quoted(added.folder);
  const start = callHint("start_session", { project: added.name, message: "<the first task>" });
  if (how === "here") {
    return `${name} is already a project on this computer, in ${where}. Nothing was cloned.\n  ${start}`;
  }
  if (how === "adopted") {
    return `added ${name} from ${where}, which already held ${quoted(address.url)}. Nothing was cloned.\n  ${start}`;
  }
  return `cloned ${quoted(address.url)} into ${where} and added it as the project ${name}.\n  ${start}`;
}

/** What a failed add answers: a refusal in our words, or git's words quoted. */
function failureFor(address: CloneAddress, error: unknown): Error {
  if (error instanceof OperatorError) return error;
  // Not a refusal: a bug, reported by the tool source, and an assistant told only that it failed.
  if (!(error instanceof AppError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  // Ours (access, a folder taken meanwhile): said as written.
  if (error.statusCode !== 500)
    return new OperatorError("unsupported", `${error.message} Nothing was added.`);
  return new OperatorError(
    "unsupported",
    `could not clone ${quoted(address.url)}. Nothing was added. git said:\n${quote(error.message)}`
  );
}

export function addProjectTool(host: DeusHost, report: (error: unknown) => void) {
  /**
   * Adds in flight (or ended, not heard yet), by the folder they clone into,
   * lower-cased: on a case-insensitive disk `owner/App` and `owner/app` are one folder.
   */
  const flights = new Map<string, Flight>();
  const flightKey = (folder: string) => folder.toLowerCase();

  async function add(caller: Who, flight: Flight, folder: string): Promise<Added> {
    const { address } = flight;
    const projects = await host.act(caller, repos.repos, {});
    const here = projects.find(
      (p) => p.root_path && p.git_origin_url && repositoryKey(p.git_origin_url) === address.key
    );
    if (here?.root_path) return registered("here", here, here.root_path);

    // lstat counts even a dangling link as taken.
    const exists = !!fs.lstatSync(folder, { throwIfNoEntry: false });
    if (!exists) {
      flight.phase = "cloning";
      await host.act(caller, repos.gitClone, { url: address.url, targetPath: folder });
      flight.phase = "cloned";
    }

    const inspected = await host.act(caller, repos.inspectRepo, { root_path: folder });
    if (inspected.root_path !== fs.realpathSync.native(folder)) {
      throw new OperatorError(
        "unsupported",
        `The folder ${quoted(folder)} is inside another repository. Nothing was added.`
      );
    }
    const origin = inspected.git_origin_url;
    if (!origin || repositoryKey(origin) !== address.key) {
      const why = origin ? "it has a different origin" : "git reported no origin";
      throw new OperatorError(
        "unsupported",
        `Could not add ${quoted(address.url)} from ${quoted(folder)}: ${why}.`
      );
    }

    let repo: Repository;
    try {
      repo = await host.act(caller, repos.addRepo, { root_path: folder });
    } catch (error) {
      // The person may have registered the same folder while this call was cloning.
      if (!(error instanceof ConflictError && error.details)) throw error;
      repo = error.details as Repository;
    }
    return registered(exists ? "adopted" : "cloned", repo, inspected.root_path);
  }

  /** The flight for this folder now: one in flight, one ended and not heard, or a new one. */
  function flightFor(caller: Who, address: CloneAddress, folder: string): Flight {
    const held = flights.get(flightKey(folder));
    const stale = held?.settledAt !== undefined && Date.now() - held.settledAt > UNHEARD_KEPT_MS;
    if (held && !stale) {
      if (held.address.key === address.key) return held;
      if (held.settledAt === undefined) {
        throw new OperatorError(
          "unsupported",
          `The folder ${quoted(folder)} is being cloned for another repository. Nothing was cloned; no other folder is used.`
        );
      }
    }
    const flight = { address, phase: "checking" } as Flight;
    flight.done = add(caller, flight, folder);
    flight.done.then(
      (added) => {
        flight.outcome = { added };
        flight.settledAt = Date.now();
      },
      (error: unknown) => {
        flight.outcome = { error };
        flight.settledAt = Date.now();
      }
    );
    flights.set(flightKey(folder), flight);
    return flight;
  }

  /** Wait for `flight` up to `seconds`; true when it ended. */
  async function ended(flight: Flight, seconds: number): Promise<boolean> {
    if (flight.outcome) return true;
    let timer: NodeJS.Timeout | undefined;
    const cut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), seconds * 1000);
    });
    try {
      return await Promise.race([
        flight.done.then(
          () => true,
          () => true
        ),
        cut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return tool<{ repository: z.ZodString }, Caller>({
    name: "add_project",
    title: "Add project",
    description:
      "Put a repository on this computer as a project, so start_session can start work in it. Pass a GitHub owner/name, or the repository's https:// or ssh (git@host:owner/name) address. It is cloned with this computer's own git sign-in into the folder Deus clones projects into; a project already here is returned as it is, and nothing is cloned twice. Returns the project's name to pass to start_session. A large clone can outlast one call: the answer then says it is still cloning, and calling add_project again with the same repository gives the outcome.",
    input: {
      repository: z
        .string()
        .trim()
        .min(1, "must not be empty or only spaces")
        .describe(
          "A GitHub owner/name, or an https:// or ssh (git@host:owner/name) address, with no user name or password in it"
        ),
    },
    effect: "write",
    openWorld: true,
    async run({ repository }, caller, call) {
      const parsed = parseCloneAddress(repository);
      if (!parsed.ok)
        throw new OperatorError("invalid_input", `${parsed.reason} Nothing was cloned.`);
      const { address } = parsed;
      const folder = path.join(projectsFolder(), address.name);
      const flight = flightFor(caller, address, folder);
      const seconds = Math.max(0, (call.deadline - Date.now() - ANSWER_MARGIN_MS) / 1000);
      if (!(await ended(flight, seconds))) {
        const doing =
          flight.phase === "cloning"
            ? `still cloning ${quoted(address.url)} into ${quoted(folder)}.`
            : `still adding ${quoted(address.url)}.`;
        return `${doing} Call add_project again with the same repository for the outcome; nothing is cloned twice.\n  ${callHint("add_project", { repository })}`;
      }
      // Heard: the next call starts afresh (and finds the project, when it was added).
      if (flights.get(flightKey(folder)) === flight) flights.delete(flightKey(folder));
      const outcome = flight.outcome!;
      if ("error" in outcome) {
        const { error } = outcome;
        if (flight.phase !== "cloned") throw failureFor(address, error);
        let reason = "";
        if (error instanceof OperatorError)
          reason = error.message.replace(/^refused \([a-z_]+\): /, "");
        else if (error instanceof AppError && error.statusCode < 500) reason = error.message;
        else report(error);
        throw new OperatorError(
          error instanceof OperatorError ? error.code : "failed",
          `Cloned into ${quoted(folder)}, but could not add the project.${reason ? ` ${reason}` : ""}`,
          { next: callHint("add_project", { repository }) }
        );
      }
      return answerFor(address, outcome.added);
    },
  });
}
