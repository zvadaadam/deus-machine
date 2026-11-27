import { z } from "zod";

/** Preferences a client may read or write on this computer. */
export const PublicSettings = z
  .object({
    diff_view_mode: z.string(),
    chat_view: z.enum(["bubbles", "full"]),
    agent_messages: z.boolean(),
    coordinator_workspaces: z.boolean(),
    onboarding_completed: z.boolean(),
    /** A new chat starts at a level every offered model supports. */
    default_thinking_level: z.enum(["low", "medium", "high"]),
    continue_after_usage_limit: z.boolean(),
    experimental_browser: z.boolean(),
    remote_access_enabled: z.boolean(),
    /** Keep the plugged-in computer awake for a connected device. On by default. */
    remote_keep_awake: z.boolean(),
    server_name: z.string(),
  })
  .partial();

export type Settings = z.infer<typeof PublicSettings>;
export const isPublicSetting = (key: string) => Object.hasOwn(PublicSettings.shape, key);

export type SettingsSection =
  | "account"
  | "general"
  | "github"
  | "browser"
  | "devices"
  | "ai"
  | "cloud"
  | "environment"
  | "slack"
  | "experimental"
  | "access";
