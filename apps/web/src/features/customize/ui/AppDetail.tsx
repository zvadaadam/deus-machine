/**
 * AppDetail — one app's page: what it does, its account, and the tools it
 * gives every agent. Connecting installs it; removing it keeps the account
 * unless the user signs out first.
 */

import { useState } from "react";
import { ExternalLink, Loader2, MoreHorizontal, RefreshCw, Server } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "@/components/ui";
import { Switch } from "@/components/ui/switch";
import {
  INTEGRATION_CATEGORY_LABELS,
  type AppAuth,
  type AppTool,
  type AppView,
  type IntegrationsSnapshot,
} from "@shared/integrations/types";
import { openExternal } from "@/platform/native/window";
import { useDeusCloudSignIn } from "@/shared/hooks/useDeusCloudSignIn";
import {
  useAppTools,
  useCheckApp,
  useDisconnectApp,
  useInstall,
  useSetEnabled,
  useUninstall,
} from "../api/integrations.queries";
import { appStatus, connectLabel } from "../lib/status";
import { signInNeedsThisComputer, useConnectFlow } from "../lib/useConnectFlow";
import { ItemIcon } from "./ItemIcon";
import {
  AsideGroup,
  AsideLink,
  DetailPage,
  DetailSection,
  Field,
  StatusText,
  type Crumb,
} from "./DetailPage";

const SIGN_IN_LABEL: Record<AppView["app"]["auth"]["kind"], string> = {
  oauth: "Browser sign-in",
  bearer: "Access token",
  header: "API key",
  env: "Local settings",
  managed: "Browser sign-in",
  none: "None needed",
};

/** Who runs the server behind the app: its vendor, the community, the user, or a broker. */
function servedBy(view: AppView): string {
  if (view.source === "custom") return "Your server";
  // Through a broker, the tools are the broker's, whoever makes the app.
  if (view.via) return `Through ${view.via}`;
  if (view.app.transport.type === "broker") return "Hosted connector";
  return view.app.official ? "Official" : "Community";
}

export function AppDetail({
  view,
  snapshot,
  trail,
  onBack,
  onOpenPlugin,
}: {
  view: AppView;
  snapshot: IntegrationsSnapshot;
  trail: Crumb[];
  onBack: () => void;
  onOpenPlugin: (id: string) => void;
}) {
  const { app } = view;
  const install = useInstall();
  const uninstall = useUninstall();
  const setEnabled = useSetEnabled();
  const check = useCheckApp();
  const flow = useConnectFlow();
  const toolList = useAppTools(app.id, view.checkedAt, view.installed && view.toolCount !== null);
  const tools = toolList.data ?? [];
  const plugins = snapshot.plugins.filter((p) => p.plugin.apps.includes(app.id));
  const status = appStatus(view);
  const runsHere = app.local || app.transport.type === "stdio";

  // The header's action: the quickest way to a working app.
  const primary = !view.installed ? (
    app.auth.kind === "none" ? (
      <Button
        size="sm"
        disabled={install.isPending}
        onClick={() => install.mutate({ kind: "app", id: app.id })}
      >
        {install.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Add {app.name}
      </Button>
    ) : (app.auth.kind === "oauth" || app.auth.kind === "managed") && view.available ? (
      <Button size="sm" disabled={flow.pending} onClick={() => flow.start(view)}>
        {flow.pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {connectLabel(view)}
      </Button>
    ) : null
  ) : (
    <>
      <label className="text-text-secondary flex items-center gap-2 text-xs">
        <Switch
          checked={view.enabled}
          aria-label="Agents can use it"
          onCheckedChange={(enabled) => setEnabled.mutate({ kind: "app", id: app.id, enabled })}
        />
        {view.enabled ? "On" : "Off"}
      </label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`More for ${app.name}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => check.mutate(app.id)}>
            <RefreshCw className="h-3.5 w-3.5" />
            Check connection
          </DropdownMenuItem>
          {(app.docsUrl || app.homepage) && (
            <DropdownMenuItem onSelect={() => void openExternal(app.docsUrl ?? app.homepage!)}>
              <ExternalLink className="h-3.5 w-3.5" />
              Open docs
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() =>
              uninstall.mutate(
                { kind: "app", id: app.id },
                { onSuccess: view.source === "custom" ? onBack : undefined }
              )
            }
          >
            Remove from Deus
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <DetailPage
      trail={trail}
      onBack={onBack}
      icon={
        <ItemIcon
          icon={app.icon}
          name={app.name}
          size="lg"
          fallback={view.source === "custom" ? Server : undefined}
        />
      }
      title={app.name}
      byline={
        <>
          <span>{app.publisher}</span>
          <span className="text-text-muted">·</span>
          <span>{servedBy(view)}</span>
        </>
      }
      actions={primary}
      facts={[
        { label: "Status", value: <StatusText status={status} /> },
        { label: "Runs", value: runsHere ? "On this computer" : "Remote" },
        { label: "Sign-in", value: SIGN_IN_LABEL[app.auth.kind] },
        { label: "Tools", value: view.toolCount ?? "—" },
      ]}
      aside={
        <>
          <AsideGroup title="Categories">
            <div className="flex flex-wrap gap-1">
              {app.categories.map((category) => (
                <span
                  key={category}
                  className="bg-bg-elevated text-text-secondary rounded-md px-1.5 py-0.5"
                >
                  {INTEGRATION_CATEGORY_LABELS[category]}
                </span>
              ))}
            </div>
          </AsideGroup>
          {view.via || app.transport.type === "broker" ? (
            // Its tools come from the service that holds the account, not a server of its own.
            view.via && (
              <AsideGroup title="Served by">
                <span className="text-text-secondary">{view.via}</span>
              </AsideGroup>
            )
          ) : (
            <AsideGroup title={app.transport.type === "stdio" ? "Command" : "Endpoint"}>
              <span className="text-text-secondary font-mono text-[11px] break-all">
                {app.transport.type === "stdio"
                  ? [app.transport.command, ...app.transport.args].join(" ")
                  : app.transport.url}
              </span>
            </AsideGroup>
          )}
          <AsideGroup title="Available to">
            <span className="text-text-secondary">
              {view.cloud
                ? "Every agent, on this computer and in the cloud"
                : "Every agent on this computer, in every project"}
            </span>
          </AsideGroup>
          {plugins.length > 0 && (
            <AsideGroup title="In plugins">
              {plugins.map((p) => (
                <button
                  key={p.plugin.id}
                  type="button"
                  onClick={() => onOpenPlugin(p.plugin.id)}
                  className="text-text-secondary hover:text-text-primary w-fit text-left"
                >
                  {p.plugin.title}
                </button>
              ))}
            </AsideGroup>
          )}
          {(app.docsUrl || app.homepage) && (
            <AsideGroup title="Links">
              {app.docsUrl && <AsideLink href={app.docsUrl}>Documentation</AsideLink>}
              {app.homepage && <AsideLink href={app.homepage}>Website</AsideLink>}
            </AsideGroup>
          )}
        </>
      }
    >
      <DetailSection title="About">
        <p className="text-text-secondary text-sm leading-relaxed">{app.description}</p>
      </DetailSection>

      {app.auth.kind !== "none" && (
        <DetailSection title="Account">
          <AccountSection view={view} />
        </DetailSection>
      )}

      {view.installed && (
        <DetailSection
          title="Tools"
          count={view.toolCount ?? undefined}
          action={
            <button
              type="button"
              disabled={check.isPending}
              onClick={() => check.mutate(app.id)}
              className="text-text-tertiary hover:text-text-secondary flex items-center gap-1 text-xs"
            >
              {check.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {check.isPending ? "Checking…" : "Check again"}
            </button>
          }
        >
          {view.checkError && (
            <p className="text-destructive bg-destructive-tint rounded-lg px-3 py-2 text-xs break-words">
              {view.checkError}
            </p>
          )}
          {tools.length > 0 ? (
            <ToolGroups tools={tools} />
          ) : (
            !view.checkError && (
              <p className="text-text-muted text-xs">
                {view.readiness === "ready"
                  ? "Checking which tools it offers…"
                  : "Its tools appear here once it's connected."}
              </p>
            )
          )}
        </DetailSection>
      )}
    </DetailPage>
  );
}

/** Tools split the way the server marked them: read-only, and the ones that change things. */
function ToolGroups({ tools }: { tools: AppTool[] }) {
  const readOnly = tools.filter((tool) => tool.readOnly);
  const groups =
    readOnly.length > 0 && readOnly.length < tools.length
      ? [
          { title: "Read-only", tools: readOnly },
          { title: "Can make changes", tools: tools.filter((tool) => !tool.readOnly) },
        ]
      : [{ title: null, tools }];
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <div key={group.title ?? "all"} className="flex flex-col">
          {group.title && (
            <span className="text-text-muted text-2xs mb-1 font-medium tracking-wide uppercase">
              {group.title} · {group.tools.length}
            </span>
          )}
          <div className="border-border-subtle divide-border-subtle divide-y rounded-lg border">
            {group.tools.map((tool) => (
              <div key={tool.name} className="flex flex-col gap-0.5 px-3 py-2">
                <span className="text-text-primary font-mono text-xs">{tool.name}</span>
                {tool.description && (
                  <span className="text-text-tertiary text-xs leading-relaxed">
                    {tool.description}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The app's account: connected, signing in, or the form for its key. */
function AccountSection({ view }: { view: AppView }) {
  const { app, connection, readiness } = view;
  const auth = app.auth;
  const flow = useConnectFlow();
  const disconnect = useDisconnectApp();
  const signIn = useDeusCloudSignIn();
  const connected = connection !== null && connection.status === "active";

  if (view.unavailable === "account") {
    // The blocked state is the button: this app's account lives with the Deus account.
    return (
      <div className="border-border-subtle flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
        <span className="text-text-tertiary text-xs leading-relaxed">
          {connection
            ? `${app.name} is connected through your Deus account. Sign in to Deus to use it.`
            : `${app.name} connects through your Deus account. Sign in to Deus first.`}
        </span>
        <Button size="xs" disabled={signIn.isPending} onClick={() => signIn.mutate()}>
          {signIn.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          Sign in to Deus
        </Button>
      </div>
    );
  }

  if (!view.available) {
    return (
      <p className="text-text-tertiary bg-bg-elevated rounded-lg px-3 py-2.5 text-xs leading-relaxed">
        {`${app.publisher} accepts sign-ins only from apps it has approved. Deus's ${app.name} sign-in is coming soon.`}
      </p>
    );
  }

  if (connected) {
    // How the account is held decides the words, not how the app signs in today.
    const signedIn = connection.kind !== "secret";
    return (
      <div className="border-border-subtle flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-text-primary truncate text-sm">
            {connection.label ?? (signedIn ? "Signed in" : "Key saved")}
          </span>
          <span className="text-text-muted text-xs">
            {connection.kind === "managed" && view.via
              ? `Held by ${view.via} for your Deus account. Every agent in every project uses it.`
              : "Every agent in every project uses this account."}
          </span>
        </div>
        <Button
          variant="outline"
          size="xs"
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate(app.id)}
        >
          {signedIn ? "Disconnect" : "Forget key"}
        </Button>
      </div>
    );
  }

  if (auth.kind === "oauth" || auth.kind === "managed") {
    return (
      <div className="border-border-subtle flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
        <span className="text-text-tertiary text-xs leading-relaxed">
          {signInNeedsThisComputer(view)
            ? `Sign in from the computer Deus runs on: the sign-in page returns there.`
            : readiness === "needs_reauth"
              ? (connection?.lastError ?? `${app.name} asked to sign in again.`)
              : view.via
                ? `Sign in once in your browser, through ${view.via}: it keeps the sign-in and runs ${app.name}'s tools for Deus.`
                : `Sign in once in your browser. Deus keeps the sign-in on this computer and refreshes it.`}
        </span>
        {/* Before install the header carries this action; one button per page. */}
        {view.installed && (
          <Button size="xs" disabled={flow.pending} onClick={() => flow.start(view)}>
            {flow.pending && <Loader2 className="h-3 w-3 animate-spin" />}
            {connectLabel(view)}
          </Button>
        )}
      </div>
    );
  }

  if (auth.kind === "none") return null;
  return <KeyForm view={view} auth={auth} />;
}

/**
 * The form for a key, a token or a local server's settings. Its own
 * component so what was typed goes with it: once the account is connected
 * the form unmounts, and a later "Forget key" starts from an empty one.
 */
function KeyForm({
  view,
  auth,
}: {
  view: AppView;
  auth: Extract<AppAuth, { kind: "bearer" | "header" | "env" }>;
}) {
  const { app, readiness } = view;
  const flow = useConnectFlow();
  const [values, setValues] = useState<Record<string, string>>({});
  const fields =
    auth.kind === "env"
      ? auth.vars.map((v) => ({
          key: v.name,
          label: v.label,
          helpUrl: v.helpUrl,
          optional: v.optional,
        }))
      : [{ key: "token", label: auth.label, helpUrl: auth.helpUrl, optional: false }];
  const complete = fields.every((f) => f.optional || values[f.key]?.trim());

  return (
    <form
      className="border-border-subtle flex flex-col gap-3 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) flow.start(view, values);
      }}
    >
      {fields.map((field) => (
        <Field key={field.key} label={field.optional ? `${field.label} (optional)` : field.label}>
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={values[field.key] ?? ""}
            placeholder={auth.kind === "env" ? field.key : undefined}
            onChange={(event) =>
              setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
            }
          />
          {field.helpUrl && (
            <button
              type="button"
              className="text-text-tertiary hover:text-text-secondary inline-flex w-fit items-center gap-1 text-xs"
              onClick={() => void openExternal(field.helpUrl!)}
            >
              Where do I get this?
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
        </Field>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!complete || flow.pending}>
          {flow.pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {readiness === "needs_reauth" ? "Save new key" : "Connect"}
        </Button>
        {auth.kind === "bearer" && auth.cliToken === "gh" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={flow.pending}
            onClick={() => flow.start(view, { fromCli: "gh" })}
          >
            Use my GitHub CLI login
          </Button>
        )}
      </div>
      <span className="text-text-muted text-xs">
        Stored encrypted on this computer; sent only to {app.name}.
      </span>
    </form>
  );
}
