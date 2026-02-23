// gateway/router.ts
// Central dispatch: routes inbound messages to commands or agent,
// and outbound agent responses to the correct chat with batching.

import type { ChannelAdapter } from "./adapters/types";
import type { BackendClient } from "./clients/backend";
import type { SidecarClient } from "./clients/sidecar";
import type { BindingStore } from "./lib/binding-store";
import type {
  InboundMessage,
  OutboundMessage,
  AgentMessageNotification,
  AgentErrorNotification,
  GatewayCommand,
  ChannelBinding,
} from "./types";
import { parseCommand } from "./lib/parse";
import { extractText, truncate, formatWorkspaceList, formatSessionStatus, formatDiffStats } from "./lib/format";

/** Response batching: accumulate text for 2 seconds, then send */
const BATCH_FLUSH_MS = 2000;
/** Max text to accumulate before force-flushing */
const BATCH_MAX_LENGTH = 3500;

interface ResponseBatch {
  chatId: string;
  channel: "telegram" | "whatsapp";
  chunks: string[];
  totalLength: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class Router {
  private adapters = new Map<string, ChannelAdapter>();
  private backend: BackendClient;
  private sidecar: SidecarClient;
  private bindings: BindingStore;
  // Composite key (sessionId:channel:chatId) → response batch (accumulator)
  private batches = new Map<string, ResponseBatch>();

  constructor(
    backend: BackendClient,
    sidecar: SidecarClient,
    bindings: BindingStore
  ) {
    this.backend = backend;
    this.sidecar = sidecar;
    this.bindings = bindings;
  }

  /** Register a channel adapter */
  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  /** Start listening for sidecar events */
  startListening(): void {
    this.sidecar.on("message", (notif: AgentMessageNotification) => {
      this.handleAgentMessage(notif);
    });

    this.sidecar.on("error", (notif: AgentErrorNotification) => {
      this.handleAgentError(notif);
    });
  }

  /** Handle an inbound message from any channel */
  async handleInbound(msg: InboundMessage): Promise<void> {
    // Try parsing as a command
    const command = parseCommand(msg.text);
    if (command) {
      await this.handleCommand(msg, command);
      return;
    }

    // Regular message — route to agent
    await this.handleAgentQuery(msg);
  }

  // ---- Command handling ----

  private async handleCommand(msg: InboundMessage, cmd: GatewayCommand): Promise<void> {
    const reply = (text: string) => this.sendReply(msg.channel, msg.chatId, text);

    try {
      switch (cmd.type) {
        case "help":
          await reply(
            [
              "*Hive Gateway Commands*",
              "",
              "/repos - List repos and workspaces",
              "/workspace <name> - Bind this chat to a workspace",
              "/status - Show current session status",
              "/diff - Show diff stats",
              "/stop - Cancel active agent",
              "/unbind - Unbind this chat",
              "/help - Show this help",
            ].join("\n")
          );
          break;

        case "repos": {
          const repos = await this.backend.listWorkspacesByRepo();
          await reply(formatWorkspaceList(repos));
          break;
        }

        case "workspace": {
          if (!cmd.name) {
            // Show current binding or prompt to bind
            const current = this.bindings.get(msg.channel, msg.chatId);
            if (current) {
              await reply(
                `Currently bound to: *${current.repoName}/${current.workspaceName}*\n\nUse /workspace <name> to switch.`
              );
            } else {
              await reply("No workspace bound. Use /workspace <name> to bind.\nUse /repos to see available workspaces.");
            }
            break;
          }

          // Find workspace by name (fuzzy: search across all repos)
          const repos = await this.backend.listWorkspacesByRepo();
          let match: { ws: any; repoName: string } | null = null;

          for (const repo of repos) {
            for (const ws of repo.workspaces) {
              if (ws.name.toLowerCase().includes(cmd.name.toLowerCase())) {
                match = { ws, repoName: repo.repo_name };
                break;
              }
            }
            if (match) break;
          }

          if (!match) {
            await reply(`No workspace found matching "${cmd.name}". Use /repos to see all.`);
            break;
          }

          // Get or create a session for this workspace
          const sessions = await this.backend.listSessions(match.ws.id);
          let session = sessions.find((s) => s.status !== "archived");
          if (!session) {
            session = await this.backend.createSession(match.ws.id);
          }

          this.bindings.set({
            channel: msg.channel,
            chatId: msg.chatId,
            workspaceId: match.ws.id,
            sessionId: session.id,
            workspacePath: match.ws.workspace_path,
            repoName: match.repoName,
            workspaceName: match.ws.name,
          });

          await reply(`Bound to *${match.repoName}/${match.ws.name}*\nSession: ${session.id.slice(0, 8)}...\n\nSend any message to talk to the agent.`);
          break;
        }

        case "status": {
          const binding = this.requireBinding(msg);
          if (!binding) return;
          const session = await this.backend.getSession(binding.sessionId);
          await reply(formatSessionStatus(session));
          break;
        }

        case "diff": {
          const binding = this.requireBinding(msg);
          if (!binding) return;
          const stats = await this.backend.getDiffStats(binding.workspaceId);
          await reply(formatDiffStats(stats));
          break;
        }

        case "stop": {
          const binding = this.requireBinding(msg);
          if (!binding) return;
          const result = await this.backend.stopSession(binding.sessionId);
          // Also send cancel to sidecar
          this.sidecar.sendCancel(binding.sessionId);
          await reply(result.message || "Agent stopped.");
          break;
        }

        case "unbind": {
          const removed = this.bindings.remove(msg.channel, msg.chatId);
          await reply(removed ? "Chat unbound." : "No binding to remove.");
          break;
        }

        default:
          await reply("Unknown command. Use /help for available commands.");
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await reply(`Error: ${errMsg}`);
    }
  }

  // ---- Agent query dispatch ----

  private async handleAgentQuery(msg: InboundMessage): Promise<void> {
    const binding = this.requireBinding(msg);
    if (!binding) return;

    try {
      // Step 1: Save message to DB via backend HTTP API
      await this.backend.sendMessage(binding.sessionId, msg.text);

      // Step 2: Send query to sidecar via socket
      this.sidecar.sendQuery(binding.sessionId, msg.text, {
        cwd: binding.workspacePath,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.sendReply(msg.channel, msg.chatId, `Failed to send message: ${errMsg}`);
    }
  }

  // ---- Agent response handling (with batching) ----

  private handleAgentMessage(notif: AgentMessageNotification): void {
    const text = extractText(notif.data);

    // Check if this is a completion event
    const data = notif.data as Record<string, unknown> | undefined;
    const isResult = data?.type === "result";

    // Find all bindings for this session
    const bindings = this.bindings.all().filter((b) => b.sessionId === notif.id);
    if (bindings.length === 0) return;

    for (const binding of bindings) {
      const batchKey = `${notif.id}:${binding.channel}:${binding.chatId}`;

      if (isResult) {
        // Flush any accumulated text immediately on completion
        this.flushBatch(batchKey, binding);
        continue;
      }

      if (!text) continue;

      // Accumulate text in a batch
      let batch = this.batches.get(batchKey);
      if (!batch) {
        batch = {
          chatId: binding.chatId,
          channel: binding.channel,
          chunks: [],
          totalLength: 0,
          timer: null,
        };
        this.batches.set(batchKey, batch);
      }

      batch.chunks.push(text);
      batch.totalLength += text.length;

      // Force flush if we've accumulated too much
      if (batch.totalLength >= BATCH_MAX_LENGTH) {
        this.flushBatch(batchKey, binding);
        continue;
      }

      // Schedule a delayed flush
      if (batch.timer) clearTimeout(batch.timer);
      batch.timer = setTimeout(() => {
        this.flushBatch(batchKey, binding);
      }, BATCH_FLUSH_MS);
    }
  }

  private handleAgentError(notif: AgentErrorNotification): void {
    const bindings = this.bindings.all().filter((b) => b.sessionId === notif.id);
    for (const binding of bindings) {
      this.sendReply(binding.channel, binding.chatId, `Agent error: ${notif.error}`);
    }
  }

  private flushBatch(batchKey: string, binding: ChannelBinding): void {
    const batch = this.batches.get(batchKey);
    if (!batch || batch.chunks.length === 0) return;

    if (batch.timer) clearTimeout(batch.timer);

    const combined = batch.chunks.join("");
    this.batches.delete(batchKey);

    if (combined.trim()) {
      this.sendReply(binding.channel, binding.chatId, truncate(combined));
    }
  }

  // ---- Helpers ----

  /** Check for an active binding, reply with error if missing */
  private requireBinding(msg: InboundMessage): ChannelBinding | null {
    const binding = this.bindings.get(msg.channel, msg.chatId);
    if (!binding) {
      this.sendReply(
        msg.channel,
        msg.chatId,
        "No workspace bound. Use /workspace <name> to bind first.\nUse /repos to see available workspaces."
      );
      return null;
    }
    return binding;
  }

  /** Send a reply to a chat via the appropriate adapter */
  private async sendReply(channel: string, chatId: string, text: string): Promise<void> {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      console.error(`[Router] No adapter for channel: ${channel}`);
      return;
    }
    await adapter.send({ channel: channel as any, chatId, text });
  }
}
