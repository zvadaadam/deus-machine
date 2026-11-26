import type { AgentHarness } from "@shared/enums";

const providers = new Map<string, { label: string; logo?: AgentHarness }>([
  ["anthropic", { label: "Anthropic", logo: "claude-code" }],
  ["claude", { label: "Claude", logo: "claude-code" }],
  ["openai", { label: "OpenAI", logo: "codex-app-server" }],
  ["codex", { label: "Codex", logo: "codex-app-server" }],
  ["google", { label: "Google", logo: "gemini" }],
  ["gemini", { label: "Gemini", logo: "gemini" }],
  ["antigravity", { label: "Antigravity", logo: "gemini" }],
  ["xai", { label: "xAI" }],
  ["kimi", { label: "Kimi" }],
  ["copilot", { label: "GitHub Copilot" }],
  ["devin", { label: "Devin" }],
  ["meta", { label: "Meta" }],
]);

export function gatewayProvider(provider: string) {
  return providers.get(provider.toLowerCase()) ?? { label: provider.trim() || "Other" };
}
