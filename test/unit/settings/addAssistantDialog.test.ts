import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The dialog renders in a portal only in a browser: here its parts render in place.
vi.mock("@/components/ui/dialog", () => {
  const part = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children ?? null);
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? createElement("div", { role: "dialog" }, children) : null,
    DialogContent: part,
    DialogDescription: part,
    DialogFooter: part,
    DialogHeader: part,
    DialogTitle: part,
  };
});
// SVGR imports are a Vite plugin's; the marks are plain glyphs here.
vi.mock("@/assets/agents/claude-code.svg?react", () => ({ default: () => null }));
vi.mock("@/assets/agents/codex.svg?react", () => ({ default: () => null }));
vi.mock("@/assets/assistants/grok.svg?react", () => ({ default: () => null }));
vi.mock("@/assets/assistants/meta-ai.svg?react", () => ({ default: () => null }));
vi.mock("@/features/settings/api/assistants.queries", () => ({
  useAssistants: () => ({ data: [], isSuccess: true, isError: false }),
  useSetAssistantAccess: () => ({ mutateAsync: vi.fn() }),
  useRemoveAssistant: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { assistantPrompt } from "@/features/settings/lib/assistant-prompt";
import { AddAssistantDialog } from "@/features/settings/ui/sections/AssistantsSection";

const ADDRESS = "https://cloud.deusmachine.ai/mcp/mac-7f3a9c21";
const MARKS = ["ChatGPT", "Claude", "Grok", "Meta AI"];

describe("the prompt that connects an agent", () => {
  it("names the computer and carries the address exactly once", () => {
    const prompt = assistantPrompt(ADDRESS, "Studio Mac");
    expect(prompt.split(ADDRESS)).toHaveLength(2);
    expect(prompt).toBe(
      [
        'Connect to my Deus computer "Studio Mac" so you can work with my coding sessions.',
        `Add this address as a custom connector named "Deus Machine" (a remote MCP server with OAuth sign-in): ${ADDRESS}`,
        "I will sign in with my Deus account when it asks, then allow you on the computer. After that you can add a project from a git address, list, read and start sessions, send them messages, wait for results and answer their questions. Start by listing my sessions.",
      ].join("\n\n")
    );
  });

  it("leaves the name out when it is not known", () => {
    for (const name of [null, undefined, "", "  "]) {
      const prompt = assistantPrompt(ADDRESS, name);
      expect(prompt.split("\n")[0]).toBe(
        "Connect to my Deus computer so you can work with my coding sessions."
      );
      expect(prompt.split(ADDRESS)).toHaveLength(2);
    }
  });

  it("names the connector and leaves the sign-in note to the dialog", () => {
    const prompt = assistantPrompt(ADDRESS, "Studio Mac");
    expect(prompt).toContain('custom connector named "Deus Machine"');
    expect(prompt).not.toContain("organization");
  });

  it("is plain text, with no markdown", () => {
    const prompt = assistantPrompt(ADDRESS, "Studio Mac");
    expect(prompt).not.toMatch(/[`*_#>[\]]/);
    expect(prompt).not.toMatch(/^\s*[-+]\s/m);
  });
});

describe("the Add an assistant dialog", () => {
  const render = (fields: {
    address: string | null | undefined;
    signedOut?: boolean;
    remoteAccessOn?: boolean;
  }) =>
    renderToStaticMarkup(
      createElement(AddAssistantDialog, {
        open: true,
        onOpenChange: () => {},
        remoteAccessOn: fields.remoteAccessOn ?? true,
        onTurnOnRemoteAccess: () => {},
        signIn: () => {},
        signingIn: false,
        signedOut: fields.signedOut ?? false,
        address: fields.address,
        computerName: "Studio Mac",
        onRetryAddress: () => {},
      })
    );

  // renderToStaticMarkup escapes text as React does.
  const escaped = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  const STEPS = [
    "Give your assistant this prompt",
    "Sign in with your Deus account when it asks.",
    "Come back here and allow it.",
  ];
  const NOTE =
    "If it asks for an organization, choose any. The assistant only reaches this computer.";

  it("leads with the prompt, then the address, then the steps after", () => {
    const html = render({ address: ADDRESS });
    const prompt = assistantPrompt(ADDRESS, "Studio Mac");
    expect(html).toContain('role="region" aria-label="Prompt for your assistant"');
    expect(html).toContain(escaped(prompt));
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Copy prompt<\/button>/);
    expect(html).toContain(
      escaped('Or add a custom connector (MCP) named "Deus Machine" yourself with this address')
    );
    // Step 2's text stands alone (the journey finds it exactly); the note is its own line.
    expect(html).toContain(`>${STEPS[1]}</p>`);
    expect(html).toContain(`>${NOTE}</p>`);
    expect(html).toContain('aria-label="This computer&#x27;s address"');
    expect(html).toContain('aria-label="Copy address"');
    // Step 1, its prompt, its Copy prompt, the address under it, then steps 2 and 3.
    const order = [
      STEPS[0],
      escaped(prompt),
      "Copy prompt",
      'aria-label="Copy address"',
      STEPS[1],
      NOTE,
      STEPS[2],
    ].map((text) => html.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html.match(/<li/g)).toHaveLength(3);
    for (const name of MARKS) expect(html).toContain(`role="img" aria-label="${name}"`);
    // A mark is not a control.
    expect(html).not.toMatch(/<button[^>]*aria-label="(ChatGPT|Claude|Grok|Meta AI)"/);
  });

  it.each([
    ["loading", { address: undefined }],
    ["sign in", { address: null, signedOut: true }],
    ["turn on remote access", { address: null, remoteAccessOn: false }],
    ["address error", { address: null }],
  ] as const)("shows no prompt, address, steps or marks while it says %s", (_, fields) => {
    const html = render(fields);
    expect(html).toContain("Add an assistant");
    expect(html).not.toContain("Copy prompt");
    expect(html).not.toContain("Prompt for your assistant");
    expect(html).not.toContain(ADDRESS);
    expect(html).not.toContain("Copy address");
    for (const step of STEPS) expect(html).not.toContain(step);
    expect(html).not.toContain(NOTE);
    for (const name of MARKS) expect(html).not.toContain(`aria-label="${name}"`);
  });
});
