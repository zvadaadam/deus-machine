/**
 * Apps, Plugins and Skills — the catalog and its installed state.
 *
 * Three catalog views share one install system:
 *  - **App**: one service or local tool the agent reaches through MCP
 *    (GitHub, Linear, Figma, Playwright). The user **connects** it — signs in
 *    or pastes a key — once, and every project's agents get its tools.
 *  - **Plugin**: a curated bundle of apps and skills for a job ("Ship a web
 *    app"). The user **installs** it; its apps that need an account can be
 *    connected later, at first use. "Recommended" is curation, not a type.
 *  - **Skill**: an Agent Skills folder (`SKILL.md` + files) that teaches the
 *    agent a workflow. The user **adds** it; it needs no account.
 *
 * Installing and authorizing are separate states: "Installed · needs GitHub"
 * is valid. Installs are account-wide on this computer — every project and
 * workspace inherits them; there are no per-workspace bindings.
 *
 * The catalog is public data (no secrets); credentials live in the backend's
 * vault, referenced by connection records.
 */

import { z } from "zod";

export const INTEGRATION_CATEGORIES = [
  "developer",
  "design",
  "creative",
  "marketing",
  "productivity",
  "data",
  "commerce",
  "communication",
  "writing",
  "documents",
] as const;
export const IntegrationCategorySchema = z.enum(INTEGRATION_CATEGORIES);
export type IntegrationCategory = z.infer<typeof IntegrationCategorySchema>;

export const INTEGRATION_CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  developer: "Developer",
  design: "Design",
  creative: "Creative",
  marketing: "Marketing & social",
  productivity: "Productivity",
  data: "Data & analytics",
  commerce: "Commerce & payments",
  communication: "Communication",
  writing: "Writing",
  documents: "Documents",
};

// ---------------------------------------------------------------------------
// How an app authenticates. Setup is independent of transport: a remote MCP
// server can take OAuth or a pasted token; a local one takes env vars.
// ---------------------------------------------------------------------------

const HelpUrl = z.string().url().optional();

export const AppAuthSchema = z.discriminatedUnion("kind", [
  /**
   * The MCP authorization spec: discovery, PKCE, refresh. `dynamic` servers
   * register Deus as a client on the spot; `preregistered` ones (Slack,
   * Google, HubSpot…) accept only a client their vendor approved, which Deus
   * supplies per app (services/integrations/auth/clients.ts). Until it has
   * one, the app goes through its broker, or shows as coming soon.
   */
  z.object({
    kind: z.literal("oauth"),
    registration: z.enum(["dynamic", "preregistered"]).optional(),
  }),
  /** A pasted token sent as `Authorization: Bearer <token>`. */
  z.object({
    kind: z.literal("bearer"),
    label: z.string(),
    helpUrl: HelpUrl,
    /** A CLI already signed in on this computer can supply the token (`gh auth token`). */
    cliToken: z.literal("gh").optional(),
  }),
  /** A pasted key sent in a named header. */
  z.object({
    kind: z.literal("header"),
    header: z.string(),
    label: z.string(),
    helpUrl: HelpUrl,
  }),
  /** Environment variables for a local (stdio) server. */
  z.object({
    kind: z.literal("env"),
    vars: z
      .array(
        z.object({
          name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
          label: z.string(),
          helpUrl: HelpUrl,
          optional: z.boolean().optional(),
        })
      )
      .min(1),
  }),
  /**
   * The app has no server of its own to sign in to: its broker (the app's
   * `broker` field) holds the account and serves its tools, reached through
   * the person's Deus account.
   */
  z.object({ kind: z.literal("managed") }),
  /** Public servers and local tools that need nothing. */
  z.object({ kind: z.literal("none") }),
]);
export type AppAuth = z.infer<typeof AppAuthSchema>;

// ---------------------------------------------------------------------------
// Catalog entries
// ---------------------------------------------------------------------------

/** Ids become MCP server names (`mcp__<id>__<tool>`), so keep them tool-safe. */
const ItemId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and hyphens");

export const AppTransportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("http"), url: z.string().url() }),
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  }),
  /** No server of its own: the app's broker serves its tools. */
  z.object({ type: z.literal("broker") }),
]);

/**
 * A broker that can hold this app's account and serve its tools: which one,
 * and what that broker calls the app. Deus Cloud is what talks to a broker
 * (its key never reaches this computer), so the route needs the person
 * signed in to Deus. An app whose own sign-in needs a vendor-approved client
 * goes through its broker until Deus has that client; an app with no server
 * of its own (`auth.kind: "managed"`) always does.
 */
const BrokerRouteSchema = z.object({
  provider: z.enum(["composio"]),
  toolkit: z.string(),
});

/** A broker's name as the person meets it: on its sign-in page, and in Customize. */
export const BROKER_LABELS = { composio: "Composio" } as const;

export const CatalogAppSchema = z.object({
  id: ItemId,
  name: z.string().min(1),
  publisher: z.string(),
  /** Operated by the service's own vendor (vs. a community server). */
  official: z.boolean(),
  description: z.string(),
  categories: z.array(IntegrationCategorySchema).min(1),
  transport: AppTransportSchema,
  auth: AppAuthSchema,
  /** The broker that can serve this app (see BrokerRouteSchema). */
  broker: BrokerRouteSchema.optional(),
  /** Runs on this computer (stdio, or a desktop app's localhost server). */
  local: z.boolean().default(false),
  docsUrl: z.string().url().optional(),
  homepage: z.string().url().optional(),
  /** Key into the generated icon set (shared/integrations/icons.ts). */
  icon: z.string().optional(),
  /** Featured near the top of the Apps view. */
  featured: z.boolean().optional(),
});
export type CatalogApp = z.infer<typeof CatalogAppSchema>;

export const SkillSourceSchema = z.object({
  /** `owner/repo` on GitHub. */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  /** A commit sha (pinned, for catalog skills) or a branch/tag (custom). */
  ref: z.string().min(1),
  /** The skill folder inside the repo; "" for a repo whose root is the skill. */
  path: z.string(),
});
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const CatalogSkillSchema = z.object({
  /** `<repo-slug>/<skill-name>`-style id, unique across sources. */
  id: z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/),
  /** The SKILL.md `name` — also the folder name the agents load it from. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string(),
  description: z.string(),
  categories: z.array(IntegrationCategorySchema).min(1),
  publisher: z.string(),
  official: z.boolean(),
  license: z.string().optional(),
  source: SkillSourceSchema,
  /** Apps whose tools this skill expects (by app id). */
  requiresApps: z.array(z.string()).default([]),
  homepage: z.string().url().optional(),
});
export type CatalogSkill = z.infer<typeof CatalogSkillSchema>;

export const CatalogPluginSchema = z.object({
  id: ItemId,
  title: z.string(),
  tagline: z.string(),
  description: z.string(),
  categories: z.array(IntegrationCategorySchema).min(1),
  publisher: z.string(),
  apps: z.array(z.string()),
  skills: z.array(z.string()),
});
export type CatalogPlugin = z.infer<typeof CatalogPluginSchema>;

export const CatalogSchema = z.object({
  version: z.string(),
  apps: z.array(CatalogAppSchema),
  skills: z.array(CatalogSkillSchema),
  plugins: z.array(CatalogPluginSchema),
});
export type Catalog = z.infer<typeof CatalogSchema>;

// ---------------------------------------------------------------------------
// Installed state
//
// Two things travel separately. The catalog is static for a build, so a
// client reads it once (the `integrationsCatalog` request). What is installed
// and connected changes, so it is pushed (the `integrations` resource) — and
// carries only that: a few kilobytes, not the catalog again on every change.
// `composeSnapshot` (compose.ts) joins the two into the views the UI draws.
// ---------------------------------------------------------------------------

export const InstallKindSchema = z.enum(["app", "skill", "plugin"]);
export type InstallKind = z.infer<typeof InstallKindSchema>;

/** Where an item came from: the curated catalog, or the user's own. */
export type ItemSource = "catalog" | "custom";

/** `removing`: removed here, waiting for Deus Cloud to disconnect the account. */
export type ConnectionStatus = "pending" | "active" | "needs_reauth" | "removing";

/** One tool a server listed, as the app's page shows it (the `appTools` request). */
export interface AppTool {
  name: string;
  description?: string;
  /** The server marked it read-only (MCP `readOnlyHint`). */
  readOnly?: boolean;
}

/**
 * How an app's account is held:
 *  - `oauth`: tokens from the MCP sign-in, sealed on this computer
 *  - `secret`: a pasted key or a local server's variables, sealed on this computer
 *  - `cli`: nothing stored; a CLI signed in on this computer supplies the token at each use
 *  - `managed`: Deus Cloud holds it, for the Deus account that connected it
 */
export type ConnectionKind = "oauth" | "secret" | "cli" | "managed";

/** An authorized account (or a configured key) for one app. Never carries secrets. */
export interface ConnectionView {
  kind: ConnectionKind;
  label: string | null;
  status: ConnectionStatus;
  /** The account's last problem (a refused refresh, a rejected key). */
  lastError: string | null;
}

/** An installed app, as pushed. */
export interface AppState {
  id: string;
  /** The user's own server is in no catalog: its definition travels with its state. */
  definition?: CatalogApp;
  enabled: boolean;
  connection: ConnectionView | null;
  /** How many tools its server listed at the last check; null before one. */
  toolCount: number | null;
  /** What the last check could not do (the server did not answer, …). */
  checkError: string | null;
  checkedAt: string | null;
}

export type SkillInstallStatus = "installing" | "ready" | "error";

/** An installed skill, as pushed. */
export interface SkillState {
  id: string;
  /** The user's own skill: its definition travels with its state. */
  definition?: CatalogSkill;
  enabled: boolean;
  /** The commit whose files are installed. */
  installedRef: string | null;
  status: SkillInstallStatus;
  error: string | null;
}

/** The `integrations` resource: everything that can change, and nothing that cannot. */
export interface IntegrationsState {
  catalogVersion: string;
  apps: AppState[];
  skills: SkillState[];
  /** Installed plugin ids. */
  plugins: string[];
  /** Catalog apps that cannot be connected right now, and why. */
  unavailable: Record<string, AppUnavailable>;
  /** Apps whose account goes through a broker right now: app id → the broker's name. */
  brokered: Record<string, string>;
  /** Cloud turns carry the account's apps and skills too (the platform supports it). */
  cloudTurns: boolean;
}

/**
 * Why an app cannot be connected right now:
 *  - `account`: it connects through the person's Deus account, and no one is signed in
 *  - `soon`: nothing can sign it in yet (no vendor-approved client, and no broker serves it)
 */
export type AppUnavailable = "account" | "soon";

/**
 * What an app can do right now, independent of being installed:
 *  - `ready`: installed and usable by the next turn
 *  - `needs_connection`: installed, but no account / key yet
 *  - `needs_reauth`: its account must sign in again
 *  - `unavailable`: it cannot be connected right now (see `AppUnavailable`)
 *  - `disabled`: installed but switched off
 *  - `not_installed`
 */
export type AppReadiness =
  | "ready"
  | "needs_connection"
  | "needs_reauth"
  | "unavailable"
  | "disabled"
  | "not_installed";

export interface AppView {
  app: CatalogApp;
  source: ItemSource;
  installed: boolean;
  enabled: boolean;
  connection: ConnectionView | null;
  readiness: AppReadiness;
  /** It can be connected right now; when not, `unavailable` says why. */
  available: boolean;
  unavailable: AppUnavailable | null;
  /** The broker its account goes through ("Composio"), or null when it signs in directly. */
  via: string | null;
  /** Cloud agents get it too, not only agents on this computer. */
  cloud: boolean;
  toolCount: number | null;
  checkError: string | null;
  checkedAt: string | null;
}

export type SkillReadiness = "ready" | "installing" | "error" | "disabled" | "not_installed";

export interface SkillView {
  skill: CatalogSkill;
  source: ItemSource;
  installed: boolean;
  enabled: boolean;
  /** The commit installed, when installed. */
  installedRef: string | null;
  /** The catalog has moved its pin since this was installed. */
  updateAvailable: boolean;
  readiness: SkillReadiness;
  error: string | null;
}

export interface PluginView {
  plugin: CatalogPlugin;
  installed: boolean;
  /** Apps in the bundle that still need an account. */
  appsNeedingConnection: string[];
}

/** The catalog joined with what is installed: what the Customize page draws. */
export interface IntegrationsSnapshot {
  apps: AppView[];
  skills: SkillView[];
  plugins: PluginView[];
}

/** A skill's SKILL.md and its other files, for its page (the `skillContent` request). */
export interface SkillContent {
  markdown: string;
  /** Paths inside the skill folder, when its files are on this computer. */
  files: string[] | null;
}

/** A skill already on this computer that Deus did not install (the `localSkills` request). */
export interface LocalSkill {
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Mutations (q:mutate) — inputs
// ---------------------------------------------------------------------------

/** The user's own server: a URL or a command (legacy SSE is not offered: Codex cannot use it). */
const CustomTransportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("http"), url: z.string().url() }),
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  }),
]);

export const CustomAppInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).optional(),
  transport: CustomTransportSchema,
  auth: AppAuthSchema,
});
export type CustomAppInput = z.infer<typeof CustomAppInputSchema>;

export const CustomSkillInputSchema = z.object({
  /** A GitHub URL (`https://github.com/o/r/tree/<ref>/<path>`) or `owner/repo[/path]`. */
  source: z.string().trim().min(3),
});

/** Connect an app: OAuth answers with a URL to open; key-based auth answers connected. */
export const ConnectAppInputSchema = z.object({
  appId: z.string(),
  /** For bearer/header: `{ token }`; for env: the variables by name. */
  values: z.record(z.string(), z.string().max(8192)).optional(),
});
export type ConnectAppInput = z.infer<typeof ConnectAppInputSchema>;

export type ConnectAppResult = { status: "connected" } | { status: "redirect"; url: string };
