/**
 * The marks of the hosted assistants a person is most likely to connect
 * (Settings, Remote access, Add an assistant). Single-colour glyphs drawn in
 * `currentColor`, so the page gives them its muted text colour.
 *
 * ChatGPT's and Claude's are the agent logos (OpenAI's and Claude's marks).
 * Grok's is `grok-icon` from @iconify-json/logos (SVG Logos, CC0 1.0) and Meta
 * AI's is `metaai` from simple-icons (CC0 1.0), copied as published with the
 * fill set to `currentColor`.
 */
import type { AgentLogoComponent } from "../agents";
import Claude from "../agents/claude-code.svg?react";
import OpenAI from "../agents/codex.svg?react";
import Grok from "./grok.svg?react";
import MetaAI from "./meta-ai.svg?react";

export const ASSISTANT_MARKS: readonly { name: string; Mark: AgentLogoComponent }[] = [
  { name: "ChatGPT", Mark: OpenAI },
  { name: "Claude", Mark: Claude },
  { name: "Grok", Mark: Grok },
  { name: "Meta AI", Mark: MetaAI },
];
