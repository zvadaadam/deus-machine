// Browser gate page for remote device pairing.
// Shown when a non-localhost browser accesses Hive without a valid token.
// Provides a split input (WORD + NUMBER) to enter a pairing code.

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

interface PairGatePageProps {
  onPaired: (token: string, deviceName?: string) => void;
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

export function PairGatePage({ onPaired }: PairGatePageProps) {
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

  const submitCode = useCallback(async (w: string, n: string) => {
    const code = `${w.toUpperCase()}-${n}`;
    setError(null);
    setIsPending(true);

    try {
      // POST to the backend's pair endpoint (same origin for remote clients)
      const baseUrl = `${window.location.protocol}//${window.location.host}`;
      const response = await fetch(`${baseUrl}/api/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          deviceName: navigator.userAgent.includes("Mobile") ? "Mobile Browser" : "Web Browser",
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        const msg = data?.error ?? "Invalid pairing code";
        setError(msg);
        return;
      }

      const data = await response.json();
      onPaired(data.token, data.device?.name);
    } catch {
      setError("Could not connect to server");
    } finally {
      setIsPending(false);
    }
  }, [onPaired]);

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
          <h1 className="text-2xl font-bold tracking-tight">Connect to Hive</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Enter the pairing code from your desktop app to connect this device.
          </p>
        </div>

        {/* Pairing form */}
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="space-y-6"
        >
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
                className="font-mono text-center text-lg uppercase tracking-wider"
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
                className="font-mono text-center text-lg tracking-wider"
                maxLength={4}
                disabled={isPending}
              />
            </div>
          </div>

          {error && (
            <p className="text-destructive text-center text-sm">{error}</p>
          )}

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
          Open Settings &gt; Remote Access in the Hive desktop app to generate a pairing code.
        </p>
      </div>
    </div>
  );
}
