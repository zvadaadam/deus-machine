import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as path from "path";
import { AgentServerClient } from "@zvada/agent-server/client";
import type { AgentHarness } from "@zvada/agent-server/protocol";
import type { DecodedWireEventEnvelope } from "@shared/protocol-types";
import { startEngine, stopEngine } from "../index";

/**
 * End-to-end: the real engine in this process (the backend's way), real
 * agent CLIs, real turns. Opt-in, because they spend tokens:
 *   DEUS_AGENT_SERVER_E2E_REAL_CLAUDE=1  (the CLI's own login or ANTHROPIC_API_KEY)
 *   DEUS_AGENT_SERVER_E2E_REAL_CODEX=1   (the CLI's own login or OPENAI_API_KEY)
 */

// A real git repository for the turns' cwd.
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..");

const suites: Array<{ harness: AgentHarness; enabled: boolean }> = [
  { harness: "claude-code", enabled: process.env.DEUS_AGENT_SERVER_E2E_REAL_CLAUDE === "1" },
  { harness: "codex-app-server", enabled: process.env.DEUS_AGENT_SERVER_E2E_REAL_CODEX === "1" },
];

describe.skipIf(!suites.some((s) => s.enabled))("E2E: the engine in process, real agents", () => {
  let client: AgentServerClient;
  const envelopes: DecodedWireEventEnvelope[] = [];
  const toolRequests: string[] = [];

  beforeAll(async () => {
    client = await AgentServerClient.attach(
      startEngine({
        request: async (method) => {
          toolRequests.push(method);
          throw new Error(`e2e host does not implement ${method}`);
        },
        title: () => {},
      })
    );
    client.onEvent((envelope) => envelopes.push(envelope));
    await client.initialize();
    await client.subscribeAll();
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await stopEngine();
  });

  /** The session's turn.ended, waited for. */
  function turnEnded(sessionId: string): Promise<DecodedWireEventEnvelope> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no turn.ended for ${sessionId}`)), 60_000);
      const find = () =>
        envelopes.find((e) => e.sessionId === sessionId && e.event.type === "turn.ended");
      const off = client.onEvent(() => {
        const ended = find();
        if (!ended) return;
        clearTimeout(timer);
        off();
        resolve(ended);
      });
      const ended = find();
      if (ended) {
        clearTimeout(timer);
        off();
        resolve(ended);
      }
    });
  }

  for (const { harness, enabled } of suites) {
    describe.skipIf(!enabled)(harness, () => {
      it("reads the CLI's login over auth/status", async () => {
        const [auth] = await client.authStatus({ harnesses: [harness] });
        expect(auth?.harness).toBe(harness);
        expect(["signed_in", "signed_out"]).toContain(auth?.state);
      }, 30_000);

      it("runs a real turn and streams its lifecycle", async () => {
        const sessionId = `e2e-${harness}-${Date.now()}`;
        const turn = await client.runTurn({
          sessionId,
          input: 'Reply with exactly the text "E2E_OK" and nothing else.',
          config: { harness, cwd: WORKSPACE_ROOT, permissionMode: "default", maxTurns: 3 },
        });
        expect((await turn.result).stopReason).toBe("end_turn");
        const ofSession = envelopes.filter((e) => e.sessionId === sessionId);
        expect(ofSession.map((e) => e.event.type)).toEqual(
          expect.arrayContaining(["session.created", "message.started", "turn.ended"])
        );
        const text = ofSession
          .map((e) => (e.event as { part?: { type?: string; text?: string } }).part)
          .map((part) => (part?.type === "text" ? (part.text ?? "") : ""))
          .join("");
        expect(text).toContain("E2E_OK");
      }, 120_000);

      it("cancels a running turn", async () => {
        const sessionId = `e2e-${harness}-cancel-${Date.now()}`;
        await client.startTurn({
          sessionId,
          turnId: "cancel-turn",
          input: "Count slowly from 1 to 1000, one number per line.",
          config: { harness, cwd: WORKSPACE_ROOT, permissionMode: "default" },
        });
        await new Promise((r) => setTimeout(r, 3_000));
        const cancel = await client.cancelTurn(sessionId);
        expect(["cancelled", "unconfirmed"]).toContain(cancel.outcome);
        const ended = await turnEnded(sessionId);
        expect((ended.event as { stopReason?: string }).stopReason).toBe("cancelled");
      }, 90_000);
    });
  }
});
