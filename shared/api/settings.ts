/** Settings: this computer's preferences, agent configuration, and the agents' logins and models. */

import { z } from "zod";
import {
  LOCAL_HARNESSES,
  type AgentAuthAnswer,
  type AgentSignInAnswer,
  type HarnessAuth,
} from "../agent-auth";
import type { CloudModelCatalog } from "../cloud-models";
import type { AgentModelsAnswer } from "../models";
import {
  HooksMapSchema,
  type AgentConfigBySection,
  type AgentConfigSection,
} from "../types/agent-config";
import type { Settings } from "../types/settings";
import { out, read, write } from "./op";

// ── Preferences ────────────────────────────────────────────────────────────

/** This computer's preferences. Its machine secrets are never among them. */
export const settings = read({ name: "settings", output: out<Settings>() });

/** Change one preference. Turning remote access on or off takes effect at once. */
export const saveSetting = write({
  name: "saveSetting",
  input: z.object({ key: z.string().min(1, "key is required"), value: z.unknown() }),
  output: out<void>(),
});

// ── Agent configuration (Claude Code's files) ──────────────────────────────

const SECTIONS = [
  "mcp-servers",
  "commands",
  "agents",
  "hooks",
  "skills",
] as const satisfies readonly AgentConfigSection[];

/**
 * Whose configuration: this computer's (`~/.claude`) or one project's
 * (`<repoPath>/.claude`). `repoPath` is required for `project`.
 */
const configScope = {
  scope: z.enum(["global", "project"]).default("global"),
  repoPath: z.string().optional(),
};

/** A command or a skill: a name and its markdown. */
const namedMarkdown = {
  name: z.string().min(1, "name is required"),
  content: z.string().min(1, "content is required"),
};

const mcpServer = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

/** One section of the configuration: a list, or for `hooks` the map by event. */
export const agentConfig = read({
  name: "agentConfig",
  input: z.object({ section: z.enum(SECTIONS), ...configScope }),
  output: out<AgentConfigBySection[AgentConfigSection]>(),
});

/**
 * Save to one section. A command, an agent or a skill is saved by itself;
 * `mcp-servers` and `hooks` are saved whole, replacing what was there.
 */
export const saveAgentConfig = write({
  name: "saveAgentConfig",
  input: z.discriminatedUnion("section", [
    z.object({
      section: z.literal("mcp-servers"),
      ...configScope,
      servers: z.array(mcpServer),
    }),
    z.object({ section: z.literal("commands"), ...configScope, ...namedMarkdown }),
    z.object({
      section: z.literal("agents"),
      ...configScope,
      id: z.string().min(1, "id is required"),
      name: z.string().optional(),
      description: z.string().optional(),
      tools: z.array(z.string()).optional(),
    }),
    z.object({ section: z.literal("hooks"), ...configScope, hooks: HooksMapSchema }),
    z.object({ section: z.literal("skills"), ...configScope, ...namedMarkdown }),
  ]),
  output: out<void>(),
});

/** Delete one command, agent or skill. The other sections have no single item to delete. */
export const deleteAgentConfig = write({
  name: "deleteAgentConfig",
  input: z.object({
    section: z.enum(["commands", "agents", "skills"]),
    itemId: z.string().min(1),
    ...configScope,
  }),
  output: out<void>(),
});

// ── The local agents: their CLIs, logins and models ────────────────────────

const localHarness = z.enum(LOCAL_HARNESSES);

/** Each local agent's CLI and login, and the sign-ins under way. */
export const agentAuth = read({ name: "agentAuth", output: out<AgentAuthAnswer>() });

/**
 * The models each local agent offers for this computer's login. A workspace
 * asks for its own folder, whose settings can narrow the list.
 */
export const agentModels = read({
  name: "agentModels",
  input: z.object({ workspaceId: z.string().optional() }),
  output: out<AgentModelsAnswer>(),
});

/** The models Deus Cloud runs, as the platform lists them; none without a cloud account. */
export const cloudModels = read({ name: "cloudModels", output: out<CloudModelCatalog>() });

/** Install the agents' CLIs now. Answers at once; progress arrives as `agent:cli` events. */
export const agentPrepareClis = write({ name: "agentPrepareClis", output: out<void>() });

/**
 * Sign a local agent in. A login this computer already has of that kind is
 * picked up; otherwise the CLI's own sign-in starts and ends as an
 * `agent:auth` event.
 */
export const agentSignIn = write({
  name: "agentSignIn",
  input: z.object({
    harness: localHarness,
    method: z.string().min(1),
    apiKey: z.string().optional(),
  }),
  output: out<AgentSignInAnswer>(),
});

/** Finish a sign-in with the code its page showed on another device. */
export const agentLoginCode = write({
  name: "agentLoginCode",
  input: z.object({ loginId: z.string().min(1), code: z.string().min(1) }),
  output: out<{ auth: HarnessAuth }>(),
});

export const agentLoginCancel = write({
  name: "agentLoginCancel",
  input: z.object({ loginId: z.string().min(1) }),
  output: out<void>(),
});

/** Sign a local agent out in its CLI: a terminal's login too, as it is the same one. */
export const agentLogout = write({
  name: "agentLogout",
  input: z.object({ harness: localHarness }),
  output: out<{ auth: HarnessAuth }>(),
});
