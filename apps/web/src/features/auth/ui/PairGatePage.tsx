// Browser gate page for remote device pairing.
// Shown when a non-localhost browser accesses OpenDevs without a valid token.
// Provides a split input (WORD + NUMBER) to enter a pairing code.
//
// In relay mode (web-production), pairing happens through a one-shot WebSocket
// to the relay's /pair endpoint. In direct mode (web-dev with remote host),
// pairing POSTs to the backend's /api/remote-auth/pair endpoint.

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { isRelayMode, RELAY_BASE_URL } from "@/shared/config/backend.config";

interface PairGatePageProps {
  onPaired: (token: string, deviceName?: string) => void;
  /** Server ID for relay mode pairing. Extracted from route params by ServerLayout. */
  serverId?: string;
}

/** Parse ?pair=WORD-NNNN from URL params. */
function getPairFromUrl(): { word: string; number: string } | null {
  const params = new URLSearchParams(window.location.search);
  const pair = params.get("pair");
  if (!pair) return null;
  const match = pair.match(/^([A-Za-z]+)-(\d{4})$/);
  if (!match) return null;
  return { word: match[1].toUpperCase(), number: match[2] };
}

/** Extract serverId from the current URL pathname (/s/{serverId}/...). */
function getServerIdFromUrl(): string | null {
  const match = window.location.pathname.match(/^\/s\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * Pair via the relay's one-shot /pair WebSocket endpoint.
 * Opens a WS to wss://relay.rundeus.com/api/servers/{serverId}/pair,
 * sends the pairing code, and waits for pair_success or pair_failed.
 */
function pairViaRelay(
  serverId: string,
  code: string,
  deviceName: string
): Promise<{ token: string }> {
  return new Promise((resolve, reject) => {
    const url = `${RELAY_BASE_URL}/api/servers/${serverId}/pair`;
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Pairing timed out"));
    }, 30_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "pair_request", code, deviceName }));
    };

    ws.onmessage = (evt) => {
      clearTimeout(timeout);
      try {
        const msg = JSON.parse(evt.data as string);
        if (msg.type === "pair_success" && msg.token) {
          resolve({ token: msg.token });
        } else if (msg.type === "pair_failed") {
          reject(new Error(msg.message || "Pairing failed"));
        } else {
          reject(new Error("Unexpected response from relay"));
        }
      } catch {
        reject(new Error("Invalid response from relay"));
      }
      ws.close();
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("Could not connect to relay"));
    };

    ws.onclose = (evt) => {
      clearTimeout(timeout);
      // If not resolved/rejected yet, treat as error
      if (evt.code !== 1000) {
        reject(new Error("Connection closed unexpectedly"));
      }
    };
  });
}

/**
 * Pair via direct HTTP POST to the backend (non-relay mode).
 */
async function pairViaDirect(
  code: string,
  deviceName: string
): Promise<{ token: string; device?: { name: string } }> {
  const baseUrl = `${window.location.protocol}//${window.location.host}`;
  const response = await fetch(`${baseUrl}/api/remote-auth/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceName }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error ?? "Invalid pairing code");
  }

  return response.json();
}

export function PairGatePage({ onPaired, serverId }: PairGatePageProps) {
  const prefill = getPairFromUrl();
  const [word, setWord] = useState(prefill?.word ?? "");
  const [number, setNumber] = useState(prefill?.number ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const numberRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Auto-submit if prefilled from QR code URL
  useEffect(() => {
    if (prefill?.word && prefill?.number) {
      submitCode(prefill.word, prefill.number);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitCode = useCallback(
    async (w: string, n: string) => {
      const code = `${w.toUpperCase()}-${n}`;
      setError(null);
      setIsPending(true);

      const deviceName = navigator.userAgent.includes("Mobile") ? "Mobile Browser" : "Web Browser";

      try {
        if (isRelayMode()) {
          // Relay mode: pair via one-shot WebSocket to relay
          const resolvedServerId = serverId || getServerIdFromUrl();
          if (!resolvedServerId) {
            setError("No server ID available for pairing");
            return;
          }
          const result = await pairViaRelay(resolvedServerId, code, deviceName);
          onPaired(result.token, deviceName);
        } else {
          // Direct mode: pair via HTTP POST to backend
          const data = await pairViaDirect(code, deviceName);
          onPaired(data.token, data.device?.name);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not connect to server");
      } finally {
        setIsPending(false);
      }
    },
    [onPaired, serverId]
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!word.trim() || number.length !== 4) return;
    submitCode(word.trim(), number);
  }

  function handleWordChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value.replace(/[^a-zA-Z]/g, "").toUpperCase();
    setWord(val);
    setError(null);
    // Auto-advance to number field when word looks complete (2+ chars and user presses tab/enters)
  }

  function handleWordKeyDown(e: React.KeyboardEvent) {
    if ((e.key === "-" || e.key === "Tab") && word.length >= 2) {
      e.preventDefault();
      numberRef.current?.focus();
    }
  }

  function handleNumberChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value.replace(/\D/g, "").slice(0, 4);
    setNumber(val);
    setError(null);
    // Auto-submit when 4 digits entered
    if (val.length === 4 && word.trim().length >= 2) {
      submitCode(word.trim(), val);
    }
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">Connect to OpenDevs</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Enter the pairing code from your desktop app to connect this device.
          </p>
        </div>

        {/* Pairing form */}
        <form ref={formRef} onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Pairing Code</Label>
            <div className="flex items-center gap-2">
              <Input
                type="text"
                placeholder="WORD"
                value={word}
                onChange={handleWordChange}
                onKeyDown={handleWordKeyDown}
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="text-center font-mono text-lg tracking-wider uppercase"
                disabled={isPending}
              />
              <span className="text-muted-foreground text-xl font-bold">-</span>
              <Input
                ref={numberRef}
                type="text"
                inputMode="numeric"
                placeholder="0000"
                value={number}
                onChange={handleNumberChange}
                autoComplete="off"
                className="text-center font-mono text-lg tracking-wider"
                maxLength={4}
                disabled={isPending}
              />
            </div>
          </div>

          {error && <p className="text-destructive text-center text-sm">{error}</p>}

          <Button
            type="submit"
            className="w-full"
            disabled={isPending || word.length < 2 || number.length !== 4}
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Connecting...
              </>
            ) : (
              "Connect"
            )}
          </Button>
        </form>

        {/* Help text */}
        <p className="text-muted-foreground text-center text-xs">
          Open Settings &gt; Remote Access in the OpenDevs desktop app to generate a pairing code.
        </p>
      </div>
    </div>
  );
}
