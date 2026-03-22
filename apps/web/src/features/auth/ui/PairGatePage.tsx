// Browser gate page for remote device connection.
// Shown when a non-localhost browser accesses OpenDevs without a valid token.
//
// Three visual states:
//   1. Auto-connecting — QR/link path, no form, just a clean "Connecting..." with animation
//   2. Success — checkmark with spring animation, brief pause before navigating
//   3. Manual entry — single code input, shown when there's no code in the URL
//
// In relay mode (web-production), pairing happens through a one-shot WebSocket
// to the relay's /pair endpoint. In direct mode (web-dev with remote host),
// pairing POSTs to the backend's /api/remote-auth/pair endpoint.

import { useState, useRef, useEffect, useCallback } from "react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check } from "lucide-react";
import { isRelayMode, RELAY_BASE_URL } from "@/shared/config/backend.config";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EASE_OUT_QUART = [0.165, 0.84, 0.44, 1] as const;
const SPRING_OVERSHOOT = { type: "spring", stiffness: 300, damping: 20 } as const;
const SUCCESS_HOLD_MS = 1500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PairGatePageProps {
  onPaired: (token: string, deviceName?: string) => void;
  /** Server ID for relay mode pairing. Extracted from route params by ServerLayout. */
  serverId?: string;
}

type PageState = "idle" | "connecting" | "success" | "error";

// ---------------------------------------------------------------------------
// Code normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw code string to canonical form: "WORD WORD".
 * Treats dashes, underscores, and plus signs as word separators.
 * Returns null if the result isn't a valid two-word code.
 */
function normalizeCode(raw: string): string | null {
  const normalized = raw.replace(/[-_+]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  const parts = normalized.split(" ");
  if (parts.length === 2 && parts.every((p) => /^[A-Z]{2,}$/.test(p))) {
    return normalized;
  }
  return null;
}

/** Extract code from the current URL's ?pair= query parameter. */
function getPairFromUrl(): string | null {
  const pair = new URLSearchParams(window.location.search).get("pair");
  return pair ? normalizeCode(pair) : null;
}

/** Extract code from a pasted URL (e.g. "https://...?pair=SOFT+TIGER"). */
function extractCodeFromPastedUrl(text: string): string | null {
  try {
    const pair = new URL(text.trim()).searchParams.get("pair");
    return pair ? normalizeCode(pair) : null;
  } catch {
    return null;
  }
}

/** Extract serverId from the current URL pathname (/s/{serverId}/...). */
function getServerIdFromUrl(): string | null {
  const match = window.location.pathname.match(/^\/s\/([^/]+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Pairing transports
// ---------------------------------------------------------------------------

function pairViaRelay(
  serverId: string,
  code: string,
  deviceName: string
): Promise<{ token: string }> {
  return new Promise((resolve, reject) => {
    const url = `${RELAY_BASE_URL}/api/servers/${encodeURIComponent(serverId)}/pair`;
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Connection timed out. Try again."));
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
          reject(new Error(msg.message || "Connection failed. Check your code and try again."));
        } else {
          reject(new Error("Something went wrong. Try again."));
        }
      } catch {
        reject(new Error("Invalid response from relay"));
      }
      ws.close();
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("Unable to connect. Check your internet and try again."));
    };

    ws.onclose = (evt) => {
      clearTimeout(timeout);
      if (evt.code !== 1000) {
        reject(new Error("Connection lost. Try again."));
      }
    };
  });
}

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
    throw new Error(data?.error ?? "Invalid connection code");
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Pulsing dots indicator — three dots that pulse in sequence. */
function PulsingDots() {
  return (
    <div className="flex items-center justify-center gap-1.5">
      {[0, 1, 2].map((i) => (
        <m.span
          key={i}
          className="bg-foreground/60 size-1.5 rounded-full"
          animate={{ opacity: [0.3, 1, 0.3], scale: [0.85, 1, 0.85] }}
          transition={{
            duration: 1.2,
            repeat: Infinity,
            delay: i * 0.15,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
}

/** Animated checkmark — draws on with spring physics. */
function AnimatedCheckmark({ reduced }: { reduced: boolean | null }) {
  return (
    <m.div
      className="flex size-20 items-center justify-center rounded-full bg-emerald-500/10"
      initial={reduced ? false : { scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={reduced ? { duration: 0.1 } : SPRING_OVERSHOOT}
    >
      <m.div
        initial={reduced ? false : { scale: 0 }}
        animate={{ scale: 1 }}
        transition={reduced ? { duration: 0.1 } : { ...SPRING_OVERSHOOT, delay: 0.15 }}
      >
        <Check className="size-10 text-emerald-500" strokeWidth={2.5} />
      </m.div>
    </m.div>
  );
}

/** Brand mark — simple text logo for the gate page. */
function BrandMark() {
  return (
    <m.div
      className="flex items-center gap-2"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE_OUT_QUART }}
    >
      <div className="bg-foreground flex size-7 items-center justify-center rounded-lg">
        <span className="text-background text-xs font-bold">OD</span>
      </div>
      <span className="text-muted-foreground text-sm font-medium tracking-wide">OpenDevs</span>
    </m.div>
  );
}

// ---------------------------------------------------------------------------
// Page states
// ---------------------------------------------------------------------------

/** Auto-connecting view — shown when QR/link provides the code. */
function ConnectingView() {
  return (
    <m.div
      key="connecting"
      className="flex flex-col items-center gap-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.25, ease: EASE_OUT_QUART }}
    >
      <BrandMark />
      <div className="flex flex-col items-center gap-5">
        <m.h1
          className="text-xl font-semibold tracking-tight"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.1, ease: EASE_OUT_QUART }}
        >
          Connecting...
        </m.h1>
        <PulsingDots />
        <m.p
          className="text-muted-foreground max-w-[260px] text-center text-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.3 }}
        >
          Establishing a secure connection to your computer.
        </m.p>
      </div>
    </m.div>
  );
}

/** Success view — shown briefly after successful pairing. */
function SuccessView({ reduced }: { reduced: boolean | null }) {
  return (
    <m.div
      key="success"
      className="flex flex-col items-center gap-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: EASE_OUT_QUART }}
    >
      <AnimatedCheckmark reduced={reduced} />
      <m.div
        className="flex flex-col items-center gap-2"
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: reduced ? 0 : 0.25, ease: EASE_OUT_QUART }}
      >
        <h1 className="text-xl font-semibold tracking-tight">Connected</h1>
        <p className="text-muted-foreground text-sm">You're all set.</p>
      </m.div>
    </m.div>
  );
}

/** Error view for auto-connect failure — shows error + falls back to manual input. */
function AutoConnectErrorView({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <m.div
      key="auto-error"
      className="flex flex-col items-center gap-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25, ease: EASE_OUT_QUART }}
    >
      <BrandMark />
      <div className="flex flex-col items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Couldn't connect</h1>
        <p className="text-muted-foreground max-w-[280px] text-center text-sm">{error}</p>
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      </div>
    </m.div>
  );
}

/** Manual entry form — shown when there's no code in the URL. */
function ManualEntryView({
  code,
  error,
  isPending,
  codeIsValid,
  onChange,
  onPaste,
  onSubmit,
}: {
  code: string;
  error: string | null;
  isPending: boolean;
  codeIsValid: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <m.div
      key="manual"
      className="w-full max-w-sm space-y-8"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.35, ease: EASE_OUT_QUART }}
    >
      {/* Brand + heading */}
      <m.div
        className="flex flex-col items-center gap-5"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.05, ease: EASE_OUT_QUART }}
      >
        <BrandMark />
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">Connect to OpenDevs</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Enter the code from your desktop app.
          </p>
        </div>
      </m.div>

      {/* Code form */}
      <m.form
        onSubmit={onSubmit}
        className="space-y-4"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.15, ease: EASE_OUT_QUART }}
      >
        <Input
          type="text"
          placeholder="WORD WORD"
          value={code}
          onChange={onChange}
          onPaste={onPaste}
          autoFocus
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="h-12 text-center font-mono text-lg tracking-wider uppercase"
          disabled={isPending}
        />

        <AnimatePresence mode="wait">
          {error && (
            <m.p
              key="error"
              className="text-destructive text-center text-sm"
              initial={{ opacity: 0, y: -4, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -4, height: 0 }}
              transition={{ duration: 0.2 }}
            >
              {error}
            </m.p>
          )}
        </AnimatePresence>

        <Button type="submit" className="h-11 w-full" disabled={isPending || !codeIsValid}>
          {isPending ? (
            <m.span
              className="flex items-center gap-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              <PulsingDots />
              <span className="ml-1">Connecting...</span>
            </m.span>
          ) : (
            "Connect"
          )}
        </Button>
      </m.form>
    </m.div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PairGatePage({ onPaired, serverId }: PairGatePageProps) {
  const prefill = getPairFromUrl();
  const isAutoConnect = prefill !== null;

  const [code, setCode] = useState(prefill ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pageState, setPageState] = useState<PageState>(isAutoConnect ? "connecting" : "idle");

  const autoSubmitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = useReducedMotion();

  const submitCode = useCallback(
    async (rawCode: string) => {
      const normalized = normalizeCode(rawCode);
      if (!normalized) return;

      setError(null);
      setPageState("connecting");

      const deviceName = navigator.userAgent.includes("Mobile") ? "Mobile Browser" : "Web Browser";

      try {
        let token: string;
        let resolvedName: string | undefined = deviceName;

        if (isRelayMode()) {
          const resolvedServerId = serverId || getServerIdFromUrl();
          if (!resolvedServerId) {
            setError("Unable to connect. Try opening the link from your desktop app again.");
            setPageState("error");
            return;
          }
          const result = await pairViaRelay(resolvedServerId, normalized, deviceName);
          token = result.token;
        } else {
          const data = await pairViaDirect(normalized, deviceName);
          token = data.token;
          resolvedName = data.device?.name;
        }

        // Show success state, then navigate
        setPageState("success");
        setTimeout(() => onPaired(token, resolvedName), SUCCESS_HOLD_MS);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to connect. Try again.");
        setPageState("error");
      }
    },
    [onPaired, serverId]
  );

  // Auto-submit on mount if code came from URL
  useEffect(() => {
    if (prefill) {
      submitCode(prefill);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitCode(code);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setCode(e.target.value.toUpperCase());
    setError(null);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    const resolved = extractCodeFromPastedUrl(pasted) ?? normalizeCode(pasted);
    if (!resolved) return;

    e.preventDefault();
    setCode(resolved);
    setError(null);

    if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current);
    autoSubmitTimer.current = setTimeout(() => submitCode(resolved), 300);
  }

  function handleRetryAutoConnect() {
    if (prefill) {
      submitCode(prefill);
    } else {
      setPageState("idle");
      setError(null);
    }
  }

  const codeIsValid = normalizeCode(code) !== null;

  // Determine which view to render
  function renderContent() {
    // Auto-connect path: connecting or error
    if (isAutoConnect && pageState === "connecting") {
      return <ConnectingView />;
    }

    if (pageState === "success") {
      return <SuccessView reduced={reduced} />;
    }

    if (isAutoConnect && pageState === "error") {
      return (
        <AutoConnectErrorView
          error={error ?? "Unable to connect."}
          onRetry={handleRetryAutoConnect}
        />
      );
    }

    // Manual entry path
    return (
      <ManualEntryView
        code={code}
        error={pageState === "error" ? error : null}
        isPending={pageState === "connecting"}
        codeIsValid={codeIsValid}
        onChange={handleChange}
        onPaste={handlePaste}
        onSubmit={handleSubmit}
      />
    );
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <AnimatePresence mode="wait">{renderContent()}</AnimatePresence>
    </div>
  );
}
