// Browser gate page for remote device connection.
// Shown when a non-localhost browser accesses Deus without a valid token.
//
// Three visual states:
//   1. Auto-connecting — QR/link path, no form, just a clean "Connecting..." with animation
//   2. Success — grant saved immediately, ready for the parent to navigate
//   3. Manual entry — single code input, shown when there's no code in the link
//
// In relay mode (web-production), the signed-in account opens a one-shot
// WebSocket to the relay's /pair endpoint and the computer approves this
// device for that account. In direct mode (web-dev with remote host),
// pairing POSTs to the backend's /api/remote-auth/pair endpoint.

import { Collapse } from "@/components/ui/collapse";
import { useState, useRef, useEffect, useCallback } from "react";
import { AnimatePresence, m } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check } from "lucide-react";
import { isRelayMode, RELAY_BASE_URL, getServerIdFromUrl } from "@/shared/config/backend.config";
import {
  machineFingerprint,
  type RelayAccount,
  type RemoteMachine,
} from "@/platform/ws/relay-access";
import { pairDevice } from "../api/pairing-client";
import {
  discardPairCode,
  normalizePairCode as normalizeCode,
  pairCodeFromLink,
  peekPairCode,
} from "../lib/pairing-link";
import { tempo } from "@/shared/lib/tempo";
import { describeDevice } from "../lib/device-name";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPRING_OVERSHOOT = { type: "spring", stiffness: 300, damping: 20 } as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PairGatePageProps {
  onPaired: (token: string, deviceName?: string) => void;
  /** Server ID for relay mode pairing. Extracted from route params by ServerLayout. */
  serverId?: string;
  /** Relay mode: the signed-in account the computer approves this device for. */
  account?: RelayAccount | null;
  /** Relay mode: the computer, named so the code is compared against the right one. */
  machine?: RemoteMachine | null;
}

type PageState = "idle" | "connecting" | "success" | "error";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Pulsing dots indicator — three dots that pulse in sequence. Respects reduced motion. */
function PulsingDots() {
  return (
    <div className="flex items-center justify-center gap-1.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="bg-foreground/60 size-1.5 rounded-full opacity-60 motion-safe:animate-[pair-pulse_1.2s_ease-in-out_infinite]"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

/** Animated checkmark — draws on with spring physics. */
function AnimatedCheckmark() {
  return (
    <m.div
      className="bg-success/10 flex size-20 items-center justify-center rounded-full"
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ ...SPRING_OVERSHOOT, opacity: tempo.slow }}
    >
      <m.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ ...SPRING_OVERSHOOT, delay: 2 * tempo.step }}
      >
        <Check className="text-success size-10 stroke-[2.5]" />
      </m.div>
    </m.div>
  );
}

/** Brand mark — simple text logo for the gate page. */
function BrandMark() {
  return (
    <div className="enter-step flex items-center gap-2 [--enter-y:-4px] [--step:0]">
      <div className="bg-foreground flex size-7 items-center justify-center rounded-lg">
        <span className="text-background text-xs font-bold">D</span>
      </div>
      <span className="text-muted-foreground text-sm font-medium tracking-wide">Deus</span>
    </div>
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
      exit={{ opacity: 0, scale: 0.98, transition: tempo.slow.exit }}
      transition={tempo.slow}
    >
      <BrandMark />
      <div className="flex flex-col items-center gap-5">
        <h1 className="enter-step text-xl font-semibold tracking-tight [--enter-y:8px] [--step:2]">
          Connecting...
        </h1>
        <PulsingDots />
        <p className="enter-step text-muted-foreground max-w-[260px] text-center text-sm [--enter-y:0px] [--step:5]">
          Establishing a secure connection to your computer.
        </p>
      </div>
    </m.div>
  );
}

/** Success view — shown briefly after successful pairing. */
function SuccessView() {
  return (
    <m.div
      key="success"
      className="flex flex-col items-center gap-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: tempo.slow.exit }}
      transition={tempo.slow}
    >
      <AnimatedCheckmark />
      <div className="enter-step flex flex-col items-center gap-2 [--enter-y:8px] [--step:4]">
        <h1 className="text-xl font-semibold tracking-tight">Connected</h1>
        <p className="text-muted-foreground text-sm">You're all set.</p>
      </div>
    </m.div>
  );
}

/** Error view for auto-connect failure — shows error + falls back to manual input. */
function AutoConnectErrorView({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div key="auto-error" className="enter-step flex flex-col items-center gap-6 [--enter-y:0px]">
      <BrandMark />
      <div className="flex flex-col items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Couldn't connect</h1>
        <p className="text-muted-foreground max-w-[280px] text-center text-sm">{error}</p>
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      </div>
    </div>
  );
}

/** Manual entry form — shown when there's no code in the URL. */
function ManualEntryView({
  code,
  error,
  isPending,
  codeIsValid,
  machine,
  onChange,
  onPaste,
  onSubmit,
}: {
  code: string;
  error: string | null;
  isPending: boolean;
  codeIsValid: boolean;
  machine?: RemoteMachine | null;
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
      exit={{ opacity: 0, y: -8, transition: tempo.slow.exit }}
      transition={tempo.slow}
    >
      {/* Brand + heading */}
      <div className="enter-step flex flex-col items-center gap-5 [--enter-y:8px] [--step:1]">
        <BrandMark />
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">Approve this device</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Enter the code from Deus on your computer, under Settings → Remote access.
          </p>
          {machine && (
            <p className="text-muted-foreground mt-3 text-xs">
              For <span className="text-foreground font-medium">{machine.name}</span>
              <span className="font-mono"> · {machineFingerprint(machine.id)}</span>, which Remote
              access shows beside the code.
            </p>
          )}
        </div>
      </div>

      {/* Code form */}
      <form onSubmit={onSubmit} className="enter-step space-y-4 [--enter-y:8px] [--step:3]">
        <label htmlFor="connection-code" className="sr-only">
          Connection code
        </label>
        <Input
          id="connection-code"
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
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "connection-code-error" : undefined}
        />

        <AnimatePresence mode="wait">
          {error && (
            <Collapse
              id="connection-code-error"
              key="error"
              className="text-destructive text-center text-sm"
              role="alert"
            >
              {error}
            </Collapse>
          )}
        </AnimatePresence>

        <Button type="submit" className="h-11 w-full" disabled={isPending || !codeIsValid}>
          {isPending ? (
            <span className="flex animate-[fadeIn_var(--tempo-fast)_var(--tempo-ease)] items-center gap-2">
              <PulsingDots />
              <span className="ml-1">Connecting...</span>
            </span>
          ) : (
            "Connect"
          )}
        </Button>
      </form>
    </m.div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PairGatePage({ onPaired, serverId, account, machine }: PairGatePageProps) {
  const linkScope = serverId ?? getServerIdFromUrl() ?? "standalone";
  const [prefill] = useState(() => peekPairCode(linkScope));
  const isAutoConnect = prefill !== null;

  const [code, setCode] = useState(prefill ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pageState, setPageState] = useState<PageState>(isAutoConnect ? "connecting" : "idle");

  const autoSubmitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAttempt = useRef<AbortController | null>(null);

  // Pairing belongs to this page/host. Late replies must not store a grant after leaving.
  useEffect(() => {
    return () => {
      if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current);
      pendingAttempt.current?.abort();
      pendingAttempt.current = null;
    };
  }, []);

  const submitCode = useCallback(
    async (rawCode: string) => {
      const normalized = normalizeCode(rawCode);
      if (!normalized || pendingAttempt.current) return;
      const attempt = new AbortController();
      pendingAttempt.current = attempt;

      setError(null);
      setPageState("connecting");

      const deviceName = describeDevice(navigator.userAgent, {
        touch: navigator.maxTouchPoints > 1,
      });

      try {
        const relay = isRelayMode();
        const resolvedServerId = serverId ?? getServerIdFromUrl();
        if (relay && !resolvedServerId) {
          throw new Error("Unable to connect. Try opening the link from your desktop app again.");
        }
        if (relay && !account) throw new Error("Sign in to approve this device.");
        const result = await pairDevice(
          relay
            ? {
                kind: "relay",
                baseUrl: RELAY_BASE_URL,
                serverId: resolvedServerId!,
                account: account!,
              }
            : { kind: "direct", baseUrl: window.location.origin },
          normalized,
          deviceName,
          attempt.signal
        );
        if (attempt.signal.aborted) return;

        // Save the one-use grant immediately. An animation delay must not lose
        // access if the user reloads or closes the tab after the code is consumed.
        onPaired(result.token, result.deviceName);
        setPageState("success");
      } catch (err) {
        if (attempt.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Unable to connect. Try again.");
        setPageState("error");
      } finally {
        if (pendingAttempt.current === attempt) pendingAttempt.current = null;
      }
    },
    [onPaired, serverId, account]
  );

  useEffect(() => {
    // The link's one-use code never reached a server (it is a fragment); drop it
    // from history and storage before it is submitted.
    discardPairCode(linkScope);
    if (!prefill) return;
    // Defer admission until after effect setup: React StrictMode's probe cleanup
    // can then cancel it before a one-use code reaches the server twice.
    const timer = setTimeout(() => void submitCode(prefill), 0);
    return () => clearTimeout(timer);
  }, [prefill, submitCode, linkScope]);

  function clearAutoSubmitTimer() {
    if (autoSubmitTimer.current) {
      clearTimeout(autoSubmitTimer.current);
      autoSubmitTimer.current = null;
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    clearAutoSubmitTimer();
    submitCode(code);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    clearAutoSubmitTimer();
    setCode(e.target.value.toUpperCase());
    setError(null);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    const resolved = pairCodeFromLink(pasted) ?? normalizeCode(pasted);
    if (!resolved) return;

    e.preventDefault();
    setCode(resolved);
    setError(null);

    clearAutoSubmitTimer();
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

  function renderContent() {
    if (isAutoConnect && pageState === "connecting") {
      return <ConnectingView />;
    }

    if (pageState === "success") {
      return <SuccessView />;
    }

    if (isAutoConnect && pageState === "error") {
      return (
        <AutoConnectErrorView
          error={error ?? "Unable to connect."}
          onRetry={handleRetryAutoConnect}
        />
      );
    }

    return (
      <ManualEntryView
        code={code}
        error={pageState === "error" ? error : null}
        isPending={pageState === "connecting"}
        codeIsValid={codeIsValid}
        machine={machine}
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
