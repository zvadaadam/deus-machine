import { useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Copy, LogIn, MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import type { Assistant } from "@shared/types/assistants";
import { formatTimeAgo } from "@/shared/lib/formatters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useAssistants,
  useRemoveAssistant,
  useSetAssistantAccess,
} from "../../api/assistants.queries";
import {
  ACCESS_CHOICES,
  accessLabel,
  addAssistantState,
  assistantOrigin,
  sortAssistants,
  type AllowedAccess as Access,
} from "../../lib/assistants";

const timeAgo = (epochMs: number) => formatTimeAgo(new Date(epochMs).toISOString());

/** What the person does about remote access, offered in place where it blocks an assistant. */
interface AssistantsSectionProps {
  remoteAccessOn: boolean;
  onTurnOnRemoteAccess: () => void;
  signIn: () => void;
  signingIn: boolean;
  /** Whether no Deus account is signed in here; shown only while there is no address. */
  signedOut: boolean;
  /**
   * This computer's address for assistants, as the relay status reports it
   * (`assistantUrl`); null while there is none, undefined while it is read.
   */
  address: string | null | undefined;
  /** Read the relay status again. */
  onRetryAddress: () => void;
}

function ChoiceText({ choice }: { choice: (typeof ACCESS_CHOICES)[number] }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span>{choice.label}</span>
      <span className="text-muted-foreground text-xs">{choice.description}</span>
    </span>
  );
}

/**
 * Where the assistant signs in, since its name is its own choice: the host its
 * sign-in returns to, or its client id while that is unknown.
 */
function Origin({ assistant, waiting = false }: { assistant: Assistant; waiting?: boolean }) {
  const origin = assistantOrigin(assistant);
  const lead = waiting ? `${origin.lead} ` : "";
  if ("host" in origin) return <>{`${lead}${origin.host}`}</>;
  return (
    <>
      {lead}
      <span className="font-mono">{origin.clientId}</span>
    </>
  );
}

/** The card a blocked step shows: what is missing, and the action that fixes it. */
function FixCard({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-border/60 bg-muted/30 flex items-center justify-between gap-4 rounded-xl border px-4 py-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{detail}</p>
      </div>
      {children}
    </div>
  );
}

const STEPS = [
  "In your assistant, add a custom connector (MCP) and paste this address.",
  "Sign in with your Deus account when it asks.",
  "Come back here and allow it.",
];

function AddAssistantDialog({
  open,
  onOpenChange,
  remoteAccessOn,
  onTurnOnRemoteAccess,
  signIn,
  signingIn,
  signedOut,
  address: url,
  onRetryAddress,
}: AssistantsSectionProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [copied, setCopied] = useState(false);
  const state = addAssistantState({ address: url, signedOut, remoteAccessOn });

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyAddress() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Address copied");
    } catch {
      toast.error("Couldn't copy the address");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add an assistant</DialogTitle>
          <DialogDescription>
            Connect ChatGPT, Claude or another assistant that supports custom connectors.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {state === "address" ? (
            <>
              <div className="space-y-1.5">
                <p className="text-muted-foreground text-xs">This computer&apos;s address</p>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={url ?? ""}
                    aria-label="This computer's address"
                    className="font-mono text-xs"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label="Copy address"
                    onClick={() => void copyAddress()}
                  >
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </Button>
                </div>
              </div>
              <ol className="space-y-2.5">
                {STEPS.map((step, index) => (
                  <li key={step} className="flex items-start gap-3 text-sm">
                    <span className="bg-muted text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                      {index + 1}
                    </span>
                    <span className="pt-px">{step}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : state === "loading" ? (
            <div className="bg-muted/40 h-9 w-full animate-pulse rounded-lg" />
          ) : state === "sign_in" ? (
            <FixCard
              title="Sign in to add an assistant"
              detail="Assistants reach this computer through your Deus account."
            >
              <Button size="sm" onClick={signIn} disabled={signingIn}>
                <LogIn className="mr-1.5 size-3.5" />
                Sign in
              </Button>
            </FixCard>
          ) : state === "turn_on" ? (
            <FixCard
              title="Turn on remote access"
              detail="Assistants reach this computer the same way your devices do."
            >
              <Switch
                aria-label="Allow remote access"
                checked={remoteAccessOn}
                onCheckedChange={(on) => on && onTurnOnRemoteAccess()}
              />
            </FixCard>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <p className="text-muted-foreground text-sm">
                Couldn&apos;t get this computer&apos;s address.
              </p>
              <Button variant="outline" size="sm" onClick={onRetryAddress}>
                Try again
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WaitingRow({
  assistant,
  busy,
  onAllow,
  onDeny,
}: {
  assistant: Assistant;
  busy: boolean;
  onAllow: (access: Access) => void;
  onDeny: () => void;
}) {
  return (
    <div className="border-border/60 bg-muted/30 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-2.5">
      <div className="flex min-w-0 grow basis-48 items-center gap-3">
        <Bot className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{assistant.name} wants to connect</p>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span className="bg-warning size-1.5 shrink-0 rounded-full" />
            <span className="min-w-0 truncate">
              <Origin assistant={assistant} waiting /> · Asked {timeAgo(assistant.createdAt)}
            </span>
          </p>
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={onDeny} disabled={busy}>
          Deny
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" disabled={busy} aria-label={`Allow ${assistant.name}`}>
              Allow
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {ACCESS_CHOICES.map((choice) => (
              <DropdownMenuItem key={choice.value} onSelect={() => onAllow(choice.value)}>
                <ChoiceText choice={choice} />
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Only allow an assistant you just connected yourself.
            </DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function AllowedRow({
  assistant,
  busy,
  onChange,
  onRemove,
}: {
  assistant: Assistant;
  busy: boolean;
  onChange: (access: Access) => void;
  onRemove: () => void;
}) {
  const label = accessLabel(assistant.access);
  return (
    <div className="bg-muted/30 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-4 py-2.5">
      <div className="flex min-w-0 grow basis-48 items-center gap-3">
        <Bot className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{assistant.name}</p>
          <p className="text-muted-foreground truncate text-xs">
            <Origin assistant={assistant} /> · Last used {timeAgo(assistant.lastSeenAt)}
          </p>
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              aria-label={`Access for ${assistant.name}: ${label}`}
            >
              {label}
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuRadioGroup
              value={assistant.access}
              onValueChange={(value) => {
                if (value !== assistant.access) onChange(value as Access);
              }}
            >
              {ACCESS_CHOICES.map((choice) => (
                <DropdownMenuRadioItem key={choice.value} value={choice.value}>
                  <ChoiceText choice={choice} />
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onRemove}
          disabled={busy}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

/** Denied: listed last and quietly, with a way to change its mind or forget it. */
function DeniedRow({
  assistant,
  busy,
  onAllow,
  onRemove,
}: {
  assistant: Assistant;
  busy: boolean;
  onAllow: (access: Access) => void;
  onRemove: () => void;
}) {
  return (
    <div className="bg-muted/30 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-4 py-2.5">
      <div className="flex min-w-0 grow basis-48 items-center gap-3">
        <Bot className="text-muted-foreground/60 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-muted-foreground truncate text-sm font-medium">{assistant.name}</p>
          <p className="text-muted-foreground truncate text-xs">
            <Origin assistant={assistant} />
          </p>
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span className="text-muted-foreground text-sm">Denied</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-text-primary"
              disabled={busy}
              aria-label={`Actions for ${assistant.name}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Allow
            </DropdownMenuLabel>
            {ACCESS_CHOICES.map((choice) => (
              <DropdownMenuItem key={choice.value} onSelect={() => onAllow(choice.value)}>
                {choice.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** Removing ends its access; if it connects again it waits for approval. */
function RemoveAssistantDialog({
  assistant,
  open,
  pending,
  onCancel,
  onConfirm,
}: {
  /** Kept after `open` turns false, so the closing dialog still names it. */
  assistant: Assistant | null;
  open: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Remove assistant?</DialogTitle>
          <DialogDescription>
            {assistant?.name ?? "This assistant"} can no longer reach this computer. If it connects
            again, it waits for your approval.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Hosted assistants (ChatGPT, Claude, …) that reach this computer through the
 * Deus account: the ones waiting for approval first, then the allowed ones with
 * their access, then the denied ones. Add shows the address to paste and what to do in the assistant.
 */
export function AssistantsSection(props: AssistantsSectionProps) {
  const assistantsQuery = useAssistants();
  const setAccess = useSetAssistantAccess();
  const remove = useRemoveAssistant();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [removing, setRemoving] = useState<Assistant | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const assistants = sortAssistants(assistantsQuery.data ?? []);

  // The assistant the person just connected shows up waiting: close the dialog
  // so its row, at the top of the list, is what they see.
  const waitingAtOpen = useRef<Set<string> | null>(null);
  const waitingIds = assistants.filter((a) => a.access === "pending").map((a) => a.clientId);
  const waitingKey = waitingIds.join(",");
  useEffect(() => {
    if (!dialogOpen) {
      waitingAtOpen.current = null;
      return;
    }
    if (!waitingAtOpen.current) {
      waitingAtOpen.current = new Set(waitingIds);
      return;
    }
    if (waitingIds.some((id) => !waitingAtOpen.current!.has(id))) setDialogOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- waitingKey stands for waitingIds
  }, [dialogOpen, waitingKey]);

  async function changeAccess(assistant: Assistant, access: Access) {
    setBusyId(assistant.clientId);
    try {
      await setAccess.mutateAsync({ clientId: assistant.clientId, access });
      toast.success(`Allowed ${assistant.name} to ${access === "read" ? "read" : "operate"}`);
    } catch {
      toast.error("Couldn't change access. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function deny(assistant: Assistant) {
    setBusyId(assistant.clientId);
    try {
      await setAccess.mutateAsync({ clientId: assistant.clientId, access: "denied" });
      toast.success(`Denied ${assistant.name}`);
    } catch {
      toast.error("Couldn't deny the assistant. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    try {
      await remove.mutateAsync(removing.clientId);
      toast.success(`Removed ${removing.name}`);
      setRemoveOpen(false);
    } catch {
      toast.error("Couldn't remove the assistant. Try again.");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h4 className="text-sm font-medium">Assistants</h4>
          <p className="text-muted-foreground text-xs">
            Let an assistant like ChatGPT or Claude see your workspaces and work with your agents on
            this computer.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="size-3.5" />
          Add assistant
        </Button>
      </div>

      {assistantsQuery.isError ? (
        <p className="text-muted-foreground py-0.5 text-sm">Couldn&apos;t load assistants.</p>
      ) : assistantsQuery.isSuccess && assistants.length === 0 ? (
        <p className="text-muted-foreground py-0.5 text-sm">No assistants yet.</p>
      ) : (
        <div className="space-y-1.5">
          {assistants.map((assistant) => {
            const busy = busyId === assistant.clientId;
            const allow = (access: Access) => void changeAccess(assistant, access);
            const askRemove = () => {
              setRemoving(assistant);
              setRemoveOpen(true);
            };
            return match(assistant.access)
              .with("pending", () => (
                <WaitingRow
                  key={assistant.clientId}
                  assistant={assistant}
                  busy={busy}
                  onAllow={allow}
                  onDeny={() => void deny(assistant)}
                />
              ))
              .with("denied", () => (
                <DeniedRow
                  key={assistant.clientId}
                  assistant={assistant}
                  busy={busy}
                  onAllow={allow}
                  onRemove={askRemove}
                />
              ))
              .with("read", "operate", () => (
                <AllowedRow
                  key={assistant.clientId}
                  assistant={assistant}
                  busy={busy}
                  onChange={allow}
                  onRemove={askRemove}
                />
              ))
              .exhaustive();
          })}
        </div>
      )}

      <AddAssistantDialog open={dialogOpen} onOpenChange={setDialogOpen} {...props} />
      <RemoveAssistantDialog
        assistant={removing}
        open={removeOpen}
        pending={remove.isPending}
        onCancel={() => setRemoveOpen(false)}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  );
}
