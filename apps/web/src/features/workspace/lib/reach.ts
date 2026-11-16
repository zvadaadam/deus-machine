/**
 * Where a workspace's things are, as two rules every surface asks instead of
 * deciding for itself.
 *
 * 1. `localFolder`: the workspace's folder on the computer whose backend this
 *    window talks to, or null (a cloud workspace, or one with no checkout yet).
 *    Whatever needs a local folder (an editor, Finder, this computer's agent
 *    configuration) offers nothing when it is null; what opens it here (an
 *    editor, Finder) also needs the desktop app (`openableFolder`).
 * 2. `openAddress` / `openFile`: what a click on an address or a file in the
 *    chat does. A local workspace's open on this computer; a cloud workspace's
 *    internet addresses open in the person's browser, its localhost addresses
 *    and files on the cloud computer.
 */
import { match } from "ts-pattern";
import type { Workspace } from "@shared/types/workspace";
import { capabilities } from "@/platform/capabilities";
import { hasCheckout } from "./startState";

export function localFolder(
  workspace: Pick<Workspace, "kind" | "workspace_path" | "current_session_id">
): string | null {
  if (workspace.kind === "cloud" || !hasCheckout(workspace)) return null;
  return workspace.workspace_path || null;
}

/**
 * Rule 1 for what opens a folder or file on this computer (an editor, Finder,
 * the default app): the folder, when this client can open things there (the
 * desktop app). The one check the header's Open, ⌘O, the palette and the
 * chat's Open and Reveal share.
 */
export function openableFolder(
  workspace: Pick<Workspace, "kind" | "workspace_path" | "current_session_id">,
  opensLocally: boolean = capabilities.openInExternalApp
): string | null {
  return opensLocally ? localFolder(workspace) : null;
}

/**
 * Which agent configuration applies to a workspace's agent: on this computer,
 * this computer's own (`~/.claude`) and its folder's (none before it has a
 * checkout); in the cloud, none from this computer: the agent does not run here.
 */
export type AgentConfigReach = { where: "local"; folder: string | null } | { where: "cloud" };

export function agentConfigOf(
  workspace: Pick<Workspace, "kind" | "workspace_path" | "current_session_id">
): AgentConfigReach {
  if (workspace.kind === "cloud") return { where: "cloud" };
  return { where: "local", folder: localFolder(workspace) };
}

/** What rule 2 reads of where the chat is. */
export interface ChatPlace {
  cloud: boolean;
  /** Rule 1's answer for the chat's workspace. */
  folder: string | null;
  /** Cloud only: the computer's preview address (`{{port}}` placeholder), when it reported one. */
  previewTemplate?: string | null;
  /** Cloud only: this window shows the cloud preview (the Browser tab). */
  previewTab?: boolean;
  /** Local only: this client has a Browser tab (`tabsFor`: the desktop app with
   *  its setting on). False opens addresses in the person's browser. */
  browserTab?: boolean;
}

export type ChatOpening =
  /** This computer's Browser tab. */
  | { to: "browser-tab"; url: string }
  /** The cloud preview (the Browser tab of a cloud workspace), at this port and path. */
  | { to: "cloud-preview"; port: number; url: string }
  /** The person's own browser. */
  | { to: "external"; url: string }
  /** This computer's file, previewed in the Browser tab (`/workspaces/:id/file-preview`). */
  | { to: "file-preview"; path: string }
  /** The Files (or Changes) tab's viewer, wherever the workspace's files are. */
  | { to: "files"; path: string; target: "files" | "changes" }
  | { to: "default-app"; path: string }
  | { to: "finder"; path: string }
  /** It cannot open from here: say so. */
  | { to: "say"; message: string }
  /** Nothing to offer: the action is not shown. */
  | { to: "none" };

export const CLOUD_LOCALHOST = "That address is on the cloud computer";
export const CLOUD_FILE_UNSHOWN = "This file is on the cloud computer and can't be shown here";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/** The port and path of an address on localhost, or null for an address on the internet. */
function onLocalhost(url: string): { port: number; rest: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!LOOPBACK.has(parsed.hostname.toLowerCase())) return null;
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  return { port, rest: `${parsed.pathname}${parsed.search}${parsed.hash}` };
}

/** The preview address of a port on the cloud computer, with the original path. */
function cloudPreviewUrl(template: string, port: number, rest: string): string | null {
  if (!template.includes("{{port}}")) return null;
  const base = template.split("{{port}}").join(String(port));
  try {
    return new URL(rest || "/", base).href;
  } catch {
    return null;
  }
}

/**
 * An http(s) address from the chat. `external` is "Open in External Browser":
 * the person's browser even for a local workspace.
 */
export function openAddress(url: string, place: ChatPlace, external = false): ChatOpening {
  if (!place.cloud) {
    // The Browser tab only where this client has one; elsewhere the person's browser.
    return external || place.browserTab === false
      ? { to: "external", url }
      : { to: "browser-tab", url };
  }
  const local = onLocalhost(url);
  if (!local) return { to: "external", url };
  const preview = place.previewTemplate
    ? cloudPreviewUrl(place.previewTemplate, local.port, local.rest)
    : null;
  if (!preview) return { to: "say", message: CLOUD_LOCALHOST };
  if (external) return { to: "external", url: preview };
  return place.previewTab
    ? { to: "cloud-preview", port: local.port, url: preview }
    : { to: "say", message: CLOUD_LOCALHOST };
}

export type FileHow = "preview" | "files" | "changes" | "default-app" | "finder";

const SHOWN_AS_TEXT = /\.(?:html?|md|mdx|csv|tsv)$/iu;

/** A workspace file from the chat, by what the click asks for. */
export function openFile(path: string, place: ChatPlace, how: FileHow): ChatOpening {
  return match(how)
    .with("files", "changes", (target) => ({ to: "files" as const, path, target }))
    .with("preview", () =>
      !place.cloud
        ? { to: "file-preview" as const, path }
        : // The cloud computer's files open in the Files tab, which shows text.
          SHOWN_AS_TEXT.test(path)
          ? { to: "files" as const, path, target: "files" as const }
          : { to: "say" as const, message: CLOUD_FILE_UNSHOWN }
    )
    .with("default-app", () =>
      place.folder ? { to: "default-app" as const, path } : { to: "none" as const }
    )
    .with("finder", () =>
      place.folder ? { to: "finder" as const, path } : { to: "none" as const }
    )
    .exhaustive();
}
