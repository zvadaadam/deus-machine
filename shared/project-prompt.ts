/**
 * How queued Project inputs appear in an agent's prompt. The backend writes this
 * text into every dispatch; the chat reads it back from the user echo so machine
 * inputs render as Project events rather than as something the user typed.
 */

export type ProjectInputOrigin = "human" | "agent" | "system";

export interface ProjectPromptInput {
  id: string;
  origin: ProjectInputOrigin;
  kind: string;
  message: string;
  /** Agent, session and turn that queued an agent- or tool-originated input. */
  source?: { agentId: string; sessionId: string | null; turnId: string | null } | null;
}

export type ProjectPromptSegment =
  | { type: "text"; text: string }
  | {
      type: "input";
      origin: ProjectInputOrigin;
      kind: string;
      inputId: string;
      fromAgentId: string | null;
      text: string;
    };

const SEPARATOR = "\n\n";

function header(input: ProjectPromptInput): string {
  const source = input.source
    ? `; from agent ${input.source.agentId}; session ${input.source.sessionId}; turn ${input.source.turnId}`
    : "";
  return `[${input.origin}/${input.kind}; input ${input.id}${source}]`;
}

/**
 * A lone human instruction stays verbatim, exactly as typed. Machine inputs carry
 * a header naming their origin; when a dispatch mixes the two, human inputs get
 * one too, so every part of the batch keeps an unambiguous owner.
 */
export function formatProjectPrompt(inputs: ProjectPromptInput[]): string {
  const mixed = inputs.some((input) => input.origin !== "human");
  return inputs
    .map((input) =>
      input.origin === "human" && !mixed ? input.message : `${header(input)} ${input.message}`
    )
    .join(SEPARATOR);
}

const HEADER =
  /\[(human|agent|system)\/([a-z_]+); input ([^\s;\]]+)(?:; from agent ([^\s;\]]+); session [^\s;\]]+; turn [^\s;\]]+)?\] /g;

/** Split a dispatch prompt back into its inputs. Text without headers is one human message. */
export function parseProjectPrompt(prompt: string): ProjectPromptSegment[] {
  const headers = [...prompt.matchAll(HEADER)].filter(
    (match) =>
      match.index === 0 || prompt.slice(match.index - SEPARATOR.length, match.index) === SEPARATOR
  );
  if (!headers.length) return [{ type: "text", text: prompt }];
  const segments: ProjectPromptSegment[] = [];
  const leading = prompt.slice(0, headers[0].index).replace(/\n\n$/, "");
  if (leading.trim()) segments.push({ type: "text", text: leading });
  headers.forEach((match, position) => {
    const next = headers[position + 1];
    const end = next ? next.index - SEPARATOR.length : prompt.length;
    segments.push({
      type: "input",
      origin: match[1] as ProjectInputOrigin,
      kind: match[2],
      inputId: match[3],
      fromAgentId: match[4] ?? null,
      text: prompt.slice(match.index + match[0].length, end),
    });
  });
  return segments;
}
