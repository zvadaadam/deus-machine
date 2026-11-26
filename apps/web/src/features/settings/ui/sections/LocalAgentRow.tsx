import { useState } from "react";
import { ChevronDown, Ellipsis, Cpu } from "lucide-react";
import { getAgentLogo } from "@/assets/agents";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openExternal } from "@/platform/native/window";
import type { AgentHarness } from "@shared/enums";
import { HARNESSES } from "@shared/harnesses";
import {
  cancelLocalSignIn,
  installLabel,
  installLocalAgent,
  localSignIn,
  signInLocalAgent,
  signOutLocalAgent,
  type LocalAgentState,
} from "../../lib/local-agent-login";
import { LoginCodeForm } from "./LoginCodeForm";
import { ProviderRow, StatusDot } from "./ProviderRow";
function statusLabel(state: LocalAgentState) {
  switch (state.status) {
    case "signed-in":
      return "Signed in";
    case "installing":
      return (
        ["Installing", state.version].filter(Boolean).join(" ") +
        (state.percent === undefined ? "…" : " · " + state.percent + "%")
      );
    case "checking":
      return "Checking…";
    case "failed":
      return "Unavailable";
    case "first-turn":
    case "not-installed":
      return "Not installed";
    case "install-failed":
      return "Install failed";
    case "signed-out":
      return state.login ? "Waiting for sign-in…" : "Not signed in";
  }
}
export function LocalAgentRow({
  harness,
  state,
}: {
  harness: AgentHarness;
  state: LocalAgentState;
}) {
  const [busy, setBusy] = useState(false);
  const Logo = getAgentLogo(harness) ?? Cpu;
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };
  const connected = state.status === "signed-in";
  const login = state.status === "signed-out" ? state.login : undefined;
  const detail = connected
    ? state.account
    : "detail" in state && state.status !== "installing"
      ? state.detail
      : HARNESSES[harness].vendor;
  const status = statusLabel(state);
  const auth = localSignIn(state);
  const install = installLabel(state);
  const url = login?.url ?? login?.codeUrl;
  const menu = (connected && state.auth.source === "login") || !!login;
  return (
    <div>
      <ProviderRow
        icon={<Logo className="size-5" />}
        name={HARNESSES[harness].label}
        detail={
          (state.status === "failed" || state.status === "install-failed") &&
          "detail" in state &&
          state.detail ? (
            <details className="group">
              <summary className="focus-visible:ring-ring flex cursor-pointer items-center gap-1 rounded-sm focus-visible:ring-2">
                <span className="truncate group-open:hidden">{state.detail}</span>
                <span className="hidden group-open:inline">Recovery details</span>
                <ChevronDown className="size-3 shrink-0 group-open:rotate-180" aria-hidden="true" />
              </summary>
              <p className="mt-1">{state.detail}</p>
            </details>
          ) : (
            detail
          )
        }
        status={<StatusDot tone={connected ? "ready" : "neutral"}>{status}</StatusDot>}
        action={
          install ? (
            <Button
              variant="outline"
              size="xs"
              className="pointer-coarse:min-h-11"
              disabled={busy}
              onClick={() => run(() => installLocalAgent(harness))}
            >
              {install}
            </Button>
          ) : auth?.kind === "start" ? (
            <Button
              size="xs"
              className="pointer-coarse:min-h-11"
              variant="outline"
              disabled={busy}
              onClick={() => run(() => signInLocalAgent(harness, auth.auth))}
            >
              Sign in
            </Button>
          ) : menu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={HARNESSES[harness].label + " options"}
                  className="size-8 pointer-coarse:size-11"
                >
                  <Ellipsis className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {url && (
                  <DropdownMenuItem onSelect={() => void openExternal(url)}>
                    Open sign-in page
                  </DropdownMenuItem>
                )}
                {login && (
                  <DropdownMenuItem onSelect={() => run(() => cancelLocalSignIn(login.loginId))}>
                    Cancel sign-in
                  </DropdownMenuItem>
                )}
                {connected && (
                  <DropdownMenuItem onSelect={() => run(() => signOutLocalAgent(harness))}>
                    Sign out
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />
      {auth?.kind === "code" && <LoginCodeForm loginId={auth.loginId} />}
    </div>
  );
}
