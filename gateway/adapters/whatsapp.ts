// gateway/adapters/whatsapp.ts
// WhatsApp adapter using @whiskeysockets/baileys.
// Uses QR code pairing for initial setup, persistent sessions, 65K char limit.

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  BaileysEventMap,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as path from "path";
import * as fs from "fs";
import type { ChannelAdapter } from "./types";
import type { Channel, InboundMessage, OutboundMessage } from "../types";

/** WhatsApp message size limit (bytes, not chars — but conservative at 60K) */
const WA_MAX_LENGTH = 60000;

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel: Channel = "whatsapp";
  private socket: WASocket | null = null;
  private sessionDir: string;
  private allowedUserIds: Set<string>;
  private onMessage: ((msg: InboundMessage) => void) | null = null;
  private shouldReconnect = true;

  constructor(sessionDir: string, allowedUserIds: string[] = []) {
    this.sessionDir = sessionDir;
    this.allowedUserIds = new Set(allowedUserIds);

    // Ensure session directory exists
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    this.onMessage = onMessage;
    this.shouldReconnect = true;
    await this.connectSocket();
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.socket) {
      console.error("[WhatsApp] Cannot send — not connected");
      return;
    }

    // WhatsApp JID format: number@s.whatsapp.net for individuals, number@g.us for groups
    const jid = msg.chatId.includes("@") ? msg.chatId : `${msg.chatId}@s.whatsapp.net`;

    let text = msg.text;
    if (text.length > WA_MAX_LENGTH) {
      text = text.slice(0, WA_MAX_LENGTH - 20) + "\n... [truncated]";
    }

    try {
      await this.socket.sendMessage(jid, { text });
    } catch (err) {
      console.error("[WhatsApp] Failed to send message:", err);
    }
  }

  async stop(): Promise<void> {
    console.log("[WhatsApp] Stopping...");
    this.shouldReconnect = false;
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
  }

  // ---- Internal ----

  private async connectSocket(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

    const socket = makeWASocket({
      auth: state,
      printQRInTerminal: true, // Show QR code in terminal for pairing
      // Reduce noise in logs
      logger: {
        level: "warn",
        info: () => {},
        debug: () => {},
        warn: (msg: unknown) => console.warn("[WhatsApp]", msg),
        error: (msg: unknown) => console.error("[WhatsApp]", msg),
        trace: () => {},
        fatal: (msg: unknown) => console.error("[WhatsApp] FATAL:", msg),
        child: () => ({ level: "warn", info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, trace: () => {}, fatal: () => {}, child: () => ({} as any) } as any),
      } as any,
    });

    this.socket = socket;

    // Save auth credentials on update
    socket.ev.on("creds.update", saveCreds);

    // Handle connection updates
    socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[WhatsApp] Scan the QR code above to connect");
      }

      if (connection === "open") {
        console.log("[WhatsApp] Connected successfully");
      }

      if (connection === "close") {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;

        console.log(
          `[WhatsApp] Connection closed (reason: ${reason}), reconnect: ${shouldReconnect && this.shouldReconnect}`
        );

        if (reason === DisconnectReason.loggedOut) {
          // Clear session if logged out — user must re-scan QR
          console.log("[WhatsApp] Logged out — clearing session data");
          fs.rmSync(this.sessionDir, { recursive: true, force: true });
          fs.mkdirSync(this.sessionDir, { recursive: true });
        }

        if (shouldReconnect && this.shouldReconnect) {
          // Reconnect after a delay
          setTimeout(() => {
            this.connectSocket().catch((err) => {
              console.error("[WhatsApp] Reconnection failed:", err);
            });
          }, 3000);
        }
      }
    });

    // Handle incoming messages
    socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        // Skip messages from self
        if (msg.key.fromMe) continue;

        // Extract text content
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption;

        if (!text) continue;

        // Extract sender info
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        // For groups: msg.key.participant is the sender
        // For DMs: msg.key.remoteJid is the sender
        const userId = msg.key.participant || remoteJid;
        const chatId = remoteJid;

        // Check allowlist (empty = allow all)
        if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId)) {
          return;
        }

        this.onMessage?.({
          channel: "whatsapp",
          chatId,
          userId,
          text,
          messageId: msg.key.id || "",
        });
      }
    });
  }
}
