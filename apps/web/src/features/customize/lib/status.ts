/**
 * How each item's state reads on its row and on its page. Installing and
 * authorizing are separate, so an installed app can still "need GitHub".
 */

import type { AppView, PluginView, SkillView } from "@shared/integrations/types";

export type Tone = "ready" | "attention" | "muted" | "busy" | "error";

export interface StatusLabel {
  text: string;
  tone: Tone;
}

export function appStatus(view: AppView): StatusLabel | null {
  const tools = view.toolCount;
  switch (view.readiness) {
    case "ready":
      return {
        text: tools ? `Ready · ${tools} tool${tools === 1 ? "" : "s"}` : "Ready",
        tone: view.checkError && !tools ? "error" : "ready",
      };
    case "needs_connection":
      return { text: needsWhat(view), tone: "attention" };
    case "needs_reauth":
      return { text: "Sign in again", tone: "attention" };
    case "unavailable":
      return unavailableStatus(view);
    case "disabled":
      return { text: "Off", tone: "muted" };
    case "not_installed":
      return view.available ? null : unavailableStatus(view);
  }
}

/** It connects through the person's Deus account and no one is signed in, or nothing can sign it in yet. */
function unavailableStatus(view: AppView): StatusLabel {
  return view.unavailable === "account"
    ? { text: view.installed ? "Sign in to Deus" : "Needs your Deus account", tone: "muted" }
    : { text: "Coming soon", tone: "muted" };
}

function needsWhat(view: AppView): string {
  switch (view.app.auth.kind) {
    case "oauth":
    case "managed":
      return "Needs sign-in";
    case "bearer":
    case "header":
      return `Needs ${view.app.auth.label.toLowerCase()}`;
    case "env":
      return "Needs setup";
    case "none":
      return "Ready";
  }
}

export function skillStatus(view: SkillView): StatusLabel | null {
  switch (view.readiness) {
    case "ready":
      return view.updateAvailable
        ? { text: "Update available", tone: "attention" }
        : { text: "Added", tone: "ready" };
    case "installing":
      return { text: "Adding…", tone: "busy" };
    case "error":
      return { text: "Couldn't add", tone: "error" };
    case "disabled":
      return { text: "Off", tone: "muted" };
    case "not_installed":
      return null;
  }
}

export function pluginStatus(view: PluginView): StatusLabel | null {
  if (!view.installed) return null;
  const pending = view.appsNeedingConnection.length;
  return pending
    ? {
        text: `Installed · ${pending} app${pending === 1 ? "" : "s"} to connect`,
        tone: "attention",
      }
    : { text: "Installed", tone: "ready" };
}

export const TONE_CLASS: Record<Tone, string> = {
  ready: "text-accent-green",
  attention: "text-warning",
  muted: "text-text-muted",
  busy: "text-text-tertiary",
  error: "text-destructive",
};

/** "Sign in with Linear", "Add API key" — the primary action on an app. */
export function connectLabel(view: AppView): string {
  const auth = view.app.auth;
  switch (auth.kind) {
    case "oauth":
    case "managed":
      return view.readiness === "needs_reauth" ? "Sign in again" : `Connect ${view.app.name}`;
    case "bearer":
    case "header":
      return `Add ${auth.label.toLowerCase()}`;
    case "env":
      return "Set up";
    case "none":
      return "Add";
  }
}
