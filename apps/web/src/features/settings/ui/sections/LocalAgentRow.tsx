import { useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { openExternal } from "@/platform/native/window";
import type { LocalHarness } from "@shared/agent-auth";
import {
  canSignIn,
  cancelLocalSignIn,
  finishLocalSignIn,
  installLocalAgents,
  signInLocalAgent,
  signOutLocalAgent,
  type LocalAgentState,
} from "../../lib/local-agent-login";

function Badge({ state }: { state: LocalAgentState }) {
  if (state.status === "checking") {
    return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
  }
  if (state.status === "installing") {
    return (
      <div className="text-muted-foreground flex items-center gap-1.5">
        <Loader2 className="size-4 animate-spin" />
        <span className="text-xs font-medium">
          Installing{state.version ? ` ${state.version}` : ""}
          {state.percent !== undefined ? ` · ${state.percent}%` : "…"}
        </span>
      </div>
    );
  }
  if (state.status === "not-installed") {
    return (
      <div className="text-muted-foreground flex items-center gap-1.5" title={state.error}>
        <XCircle className="size-4" />
        <span className="text-xs font-medium">
          {state.error ? "Couldn’t install" : "Not installed"}
        </span>
      </div>
    );
  }
  if (state.status === "failed") {
    return <span className="text-muted-foreground text-xs font-medium">Status unavailable</span>;
  }
  if (state.status === "signed-in") {
    return (
      <div className="text-accent-green flex items-center gap-1.5">
        <CheckCircle2 className="size-4" />
        <span className="text-xs font-medium">Connected</span>
      </div>
    );
  }
  return (
    <div className="text-muted-foreground flex items-center gap-1.5">
      <XCircle className="size-4" />
      <span className="text-xs font-medium">
        {state.status === "signed-out" && state.login ? "Waiting for sign-in…" : "Not connected"}
      </span>
    </div>
  );
}

/** A local agent: its login on this computer, and the sign-in the engine runs through its CLI. */
export function LocalAgentRow({
  harness,
  title,
  vendor,
  state,
}: {
  harness: LocalHarness;
  title: string;
  vendor: string;
  state: LocalAgentState;
}) {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };
  const login = state.status === "signed-out" ? state.login : undefined;
  const loginPage = login?.url ?? login?.codeUrl;

  return (
    <div className="border-border-subtle space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-muted-foreground text-sm">{vendor}</p>
          {state.status === "signed-in" && (
            <p className="text-muted-foreground mt-0.5 text-xs">{state.account}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge state={state} />
          {state.status === "not-installed" && (
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => run(installLocalAgents)}
            >
              {state.error ? "Try again" : "Install"}
            </Button>
          )}
          {state.status === "signed-out" && !login && canSignIn(state.auth) && (
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => run(() => signInLocalAgent(harness, state.auth))}
            >
              Sign in
            </Button>
          )}
          {loginPage && (
            <Button
              variant="outline"
              size="xs"
              className="gap-1.5"
              onClick={() => void openExternal(loginPage)}
            >
              Open sign-in page
              <ExternalLink className="size-3" />
            </Button>
          )}
          {login && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => run(() => cancelLocalSignIn(login.loginId))}
            >
              Cancel
            </Button>
          )}
          {/* The CLI signs out only a login of its own, not one from the environment. */}
          {state.status === "signed-in" && state.auth.source === "login" && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => run(() => signOutLocalAgent(harness))}
            >
              Sign out
            </Button>
          )}
        </div>
      </div>
      {login?.codeUrl && !login.url && (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim()) run(() => finishLocalSignIn(login.loginId, code.trim()));
          }}
        >
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Paste the code the sign-in page shows"
            className="h-8 text-xs"
          />
          <Button type="submit" variant="outline" size="xs" disabled={busy || !code.trim()}>
            Continue
          </Button>
        </form>
      )}
    </div>
  );
}
