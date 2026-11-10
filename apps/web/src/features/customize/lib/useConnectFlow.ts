/**
 * Connect an app. An OAuth app answers with a sign-in page, opened in the
 * browser (the callback finishes it; the app's card updates over the
 * subscription). The browser tab is reserved during the click, so a web
 * build's popup blocker lets it through.
 *
 * Everything that must happen after the request (opening the page, the
 * toasts) runs inside the mutation itself, not in callbacks handed to
 * `mutate()`: connecting installs the app first, which moves its row to the
 * Installed section and remounts it, and TanStack drops `mutate()`-level
 * callbacks of an unmounted component — the sign-in page would never open.
 */

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AppView, ConnectAppResult } from "@shared/integrations/types";
import { getErrorMessage } from "@shared/lib/errors";
import { openExternalPending, type PendingExternalWindow } from "@/platform/native/window";
import { isRelayMode } from "@/shared/config/backend.config";
import { connectApp } from "../api/integrations.queries";

/**
 * A browser sign-in returns to the computer Deus runs on, so it can only be
 * started there: on a phone or another computer (remote access) the page
 * would come back to the wrong machine.
 */
export function signInNeedsThisComputer(view: AppView): boolean {
  return (view.app.auth.kind === "oauth" || view.app.auth.kind === "managed") && isRelayMode();
}

interface ConnectRequest {
  view: AppView;
  values?: Record<string, string>;
  tab: PendingExternalWindow | null;
}

async function connect({ view, values, tab }: ConnectRequest): Promise<ConnectAppResult> {
  try {
    const result = await connectApp({ appId: view.app.id, ...(values ? { values } : {}) });
    if (result.status === "redirect") {
      await tab?.open(result.url);
      toast(`Finish signing in to ${view.app.name} in your browser`);
    } else {
      tab?.cancel();
      toast.success(`${view.app.name} is connected`);
    }
    return result;
  } catch (error) {
    tab?.cancel();
    toast.error(getErrorMessage(error));
    throw error;
  }
}

export function useConnectFlow() {
  const mutation = useMutation({ mutationFn: connect });

  const start = (view: AppView, values?: Record<string, string>) => {
    if (signInNeedsThisComputer(view)) {
      toast(`Connect ${view.app.name} from the computer Deus runs on`);
      return;
    }
    const opensBrowser = view.app.auth.kind === "oauth" || view.app.auth.kind === "managed";
    // Reserved now, during the click; `connect` sends it to the sign-in page.
    mutation.mutate({ view, values, tab: opensBrowser ? openExternalPending() : null });
  };

  return { start, pending: mutation.isPending };
}
