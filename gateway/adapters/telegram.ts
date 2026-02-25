// gateway/adapters/telegram.ts
// Telegram adapter using grammY with long polling (no webhook server needed).

import { Bot } from "grammy";
import type { ChannelAdapter } from "./types";
import type { Channel, InboundMessage, OutboundMessage } from "../types";

export class TelegramAdapter implements ChannelAdapter {
  readonly channel: Channel = "telegram";
  private bot: Bot;
  private allowedUserIds: Set<string>;

  constructor(token: string, allowedUserIds: string[] = []) {
    this.bot = new Bot(token);
    this.allowedUserIds = new Set(allowedUserIds);
  }

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    // Handle all text messages
    this.bot.on("message:text", (ctx) => {
      const userId = String(ctx.from.id);
      const chatId = String(ctx.chat.id);

      // Check allowlist (empty = allow all)
      if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId)) {
        ctx.reply("You are not authorized to use this bot.").catch(() => {});
        return;
      }

      onMessage({
        channel: "telegram",
        chatId,
        userId,
        text: ctx.message.text,
        messageId: String(ctx.message.message_id),
      });
    });

    // Start long polling
    console.log("[Telegram] Starting bot with long polling...");
    this.bot.start({
      onStart: (botInfo) => {
        console.log(`[Telegram] Bot @${botInfo.username} is running`);
      },
    });
  }

  async send(msg: OutboundMessage): Promise<void> {
    try {
      await this.bot.api.sendMessage(msg.chatId, msg.text, {
        parse_mode: msg.parseMode ?? "Markdown",
      });
    } catch (err) {
      // Fallback: retry without parse mode if Markdown fails
      if (msg.parseMode === "Markdown") {
        try {
          await this.bot.api.sendMessage(msg.chatId, msg.text);
        } catch (retryErr) {
          console.error("[Telegram] Failed to send message:", retryErr);
        }
      } else {
        console.error("[Telegram] Failed to send message:", err);
      }
    }
  }

  async stop(): Promise<void> {
    console.log("[Telegram] Stopping bot...");
    this.bot.stop();
  }
}
