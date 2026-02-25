// gateway/config.ts
// Load and validate configuration from environment variables.

import { z } from "zod";

const ConfigSchema = z.object({
  /** Telegram Bot API token from @BotFather (optional — gateway starts without it) */
  telegramBotToken: z.string().min(1).optional(),
  /** WhatsApp session directory for auth state persistence (optional) */
  whatsappSessionDir: z.string().min(1).optional(),
  /** Base URL for the Hive backend HTTP API (e.g. http://localhost:50123) */
  backendUrl: z.string().url(),
  /** Path to the sidecar Unix domain socket */
  sidecarSocketPath: z.string().min(1),
  /** Path to the bindings JSON file for persistence */
  bindingsPath: z.string().min(1),
  /** Comma-separated user IDs allowed to use the bot (empty = allow all) */
  allowedUserIds: z.array(z.string()).default([]),
  /** Comma-separated WhatsApp JIDs allowed to use the bot (empty = allow all) */
  whatsappAllowedUserIds: z.array(z.string()).default([]),
});

export type GatewayConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): GatewayConfig {
  const raw = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    whatsappSessionDir: process.env.WHATSAPP_SESSION_DIR || undefined,
    backendUrl: process.env.BACKEND_URL ?? process.env.HIVE_BACKEND_URL,
    sidecarSocketPath: process.env.SIDECAR_SOCKET_PATH,
    bindingsPath: process.env.BINDINGS_PATH ?? "/tmp/hive-gateway-bindings.json",
    allowedUserIds: process.env.ALLOWED_USER_IDS
      ? process.env.ALLOWED_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    whatsappAllowedUserIds: process.env.WHATSAPP_ALLOWED_USER_IDS
      ? process.env.WHATSAPP_ALLOWED_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
  };

  // At least one channel must be configured
  if (!raw.telegramBotToken && !raw.whatsappSessionDir) {
    throw new Error(
      "Gateway config: At least one channel must be configured.\n" +
      "  Set TELEGRAM_BOT_TOKEN for Telegram, or WHATSAPP_SESSION_DIR for WhatsApp."
    );
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const missing = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Gateway config validation failed:\n${missing.join("\n")}`);
  }

  return result.data;
}
