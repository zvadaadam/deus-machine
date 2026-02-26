// gateway/index.ts
// Entry point for the OpenDevs messaging gateway.
// Wires config, sidecar client, backend client, binding store,
// router, and channel adapters together.

import { loadConfig } from "./config";
import { BackendClient } from "./clients/backend";
import { SidecarClient } from "./clients/sidecar";
import { BindingStore } from "./lib/binding-store";
import { Router } from "./router";
import { TelegramAdapter } from "./adapters/telegram";
import { WhatsAppAdapter } from "./adapters/whatsapp";
import type { ChannelAdapter } from "./adapters/types";

async function main(): Promise<void> {
  console.log("[Gateway] Starting OpenDevs messaging gateway...");

  // 1. Load config
  const config = loadConfig();
  console.log("[Gateway] Config loaded:", {
    backendUrl: config.backendUrl,
    sidecarSocketPath: config.sidecarSocketPath,
    bindingsPath: config.bindingsPath,
    telegram: config.telegramBotToken ? "configured" : "disabled",
    whatsapp: config.whatsappSessionDir ? "configured" : "disabled",
    allowedUsers: config.allowedUserIds.length || "all",
  });

  // 2. Create service clients
  const backend = new BackendClient(config.backendUrl);
  const sidecar = new SidecarClient(config.sidecarSocketPath);
  const bindings = new BindingStore(config.bindingsPath);

  // 3. Create router and register adapters
  const router = new Router(backend, sidecar, bindings);
  const adapters: ChannelAdapter[] = [];

  // Telegram adapter (optional)
  if (config.telegramBotToken) {
    const telegram = new TelegramAdapter(config.telegramBotToken, config.allowedUserIds);
    router.registerAdapter(telegram);
    adapters.push(telegram);
    console.log("[Gateway] Telegram adapter registered");
  }

  // WhatsApp adapter (optional)
  if (config.whatsappSessionDir) {
    const whatsapp = new WhatsAppAdapter(
      config.whatsappSessionDir,
      config.whatsappAllowedUserIds
    );
    router.registerAdapter(whatsapp);
    adapters.push(whatsapp);
    console.log("[Gateway] WhatsApp adapter registered");
  }

  // 4. Connect to sidecar
  sidecar.connect();

  // 5. Start listening for agent responses
  router.startListening();

  // 6. Start all adapters
  for (const adapter of adapters) {
    await adapter.start((msg) => {
      router.handleInbound(msg).catch((err) => {
        console.error(`[Gateway] Error handling inbound ${adapter.channel} message:`, err);
      });
    });
  }

  // Signal readiness (Rust process manager looks for this)
  console.log("GATEWAY_READY");
  console.log("[Gateway] OpenDevs messaging gateway is running");

  // 7. Graceful shutdown
  const shutdown = async () => {
    console.log("[Gateway] Shutting down...");
    for (const adapter of adapters) {
      await adapter.stop().catch((err) => {
        console.error(`[Gateway] Error stopping ${adapter.channel}:`, err);
      });
    }
    sidecar.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[Gateway] Fatal error:", err);
  process.exit(1);
});
