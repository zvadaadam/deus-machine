import { useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Copy, LogIn, MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import type { Assistant } from "@shared/types/assistants";
import { formatTimeAgo } from "@/shared/lib/formatters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ASSISTANT_MARKS } from "@/assets/assistants";
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
  createDialogArrivalWatch,
  waitingAnnouncement,
  sortAssistants,
  type AllowedAccess as Access,
} from "../../lib/assistants";
import { assistantPrompt } from "../../lib/assistant-prompt";

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
  /** This computer's name as other devices see it, named in the prompt; null while unknown. */
  computerName?: string | null;
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

/** The first step carries the prompt (and, under it, the address); the other two are words. */
const STEPS = [
  "Give your assistant this prompt",
  "Sign in with your Deus account when it asks.",
  "Come back here and allow it.",
];

/** Under step 2: the sign-in page's organization choice is not ours and reaches nothing. */
const SIGN_IN_NOTE =
  "If it asks for an organization, choose any. The assistant only reaches this computer.";

/** A step's number, in the column its text hangs from. */
function StepNumber({ n }: { n: number }) {
  return (
    <span className="bg-muted text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium">
      {n}
    </span>
  );
}

/** The assistants a person is most likely to connect, so the dialog is known at a glance. */
function AssistantMarks() {
  return (
    <TooltipProvider>
      <div className="flex items-center justify-center gap-2.5 pt-0.5 sm:justify-start">
        {ASSISTANT_MARKS.map(({ name, Mark }) => (
          <Tooltip key={name}>
            <TooltipTrigger asChild>
              <span role="img" aria-label={name} className="text-muted-foreground flex">
                <Mark aria-hidden className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{name}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

export function AddAssistantDialog({
  open,
  onOpenChange,
  remoteAccessOn,
  onTurnOnRemoteAccess,
  signIn,
  signingIn,
  signedOut,
  address: url,
  computerName,
  onRetryAddress,
}: AssistantsSectionProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [copied, setCopied] = useState<"address" | "prompt" | null>(null);
  const state = addAssistantState({ address: url, signedOut, remoteAccessOn });

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyAddress() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied("address");
      toast.success("Address copied");
    } catch {
      toast.error("Couldn't copy the address");
    }
  }

  async function copyPrompt() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(assistantPrompt(url, computerName));
      setCopied("prompt");
      toast.success("Prompt copied");
    } catch {
      toast.error("Couldn't copy the prompt");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Taller than a phone's screen, it scrolls inside itself. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an assistant</DialogTitle>
          <DialogDescription>
            Let ChatGPT, Claude or another assistant work with this computer&apos;s coding sessions.
          </DialogDescription>
          {state === "address" && <AssistantMarks />}
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {state === "address" && url ? (
            <ol className="space-y-5">
              <li className="flex items-start gap-3">
                <StepNumber n={1} />
                <div className="min-w-0 flex-1 space-y-2.5">
                  <p className="pt-px text-sm font-medium">{STEPS[0]}</p>
                  {/* The prompt is the way in: shown whole, so the person knows what they hand over. */}
                  <div
                    role="region"
                    aria-label="Prompt for your assistant"
                    tabIndex={0}
                    className="border-border/60 bg-muted/30 text-foreground focus-visible:border-ring focus-visible:ring-ring/50 max-h-40 overflow-y-auto rounded-lg border px-3 py-2.5 text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap outline-none select-text focus-visible:ring-[3px]"
                  >
                    {assistantPrompt(url, computerName)}
                  </div>
                  <Button className="w-full" onClick={() => void copyPrompt()}>
                    {copied === "prompt" ? <Check /> : <Copy />}
                    Copy prompt
                  </Button>
                  {/* The manual route, for an assistant that takes only an address. */}
                  <div className="space-y-1.5 pt-1.5">
                    <p className="text-muted-foreground text-xs">
                      Or add a custom connector (MCP) named &quot;Deus Machine&quot; yourself with
                      this address
                    </p>
                    <div className="flex gap-2">
                      <Input
                        readOnly
                        value={url}
                        aria-label="This computer's address"
                        className="h-8 font-mono text-xs"
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <Button
                        variant="outline"
                        size="icon-sm"
                        className="shrink-0"
                        aria-label="Copy address"
                        onClick={() => void copyAddress()}
                      >
                        {copied === "address" ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
              {STEPS.slice(1).map((step, index) => (
                <li key={step} className="flex items-start gap-3">
                  <StepNumber n={index + 2} />
                  <div className="min-w-0 flex-1 space-y-1 pt-px">
                    <p className="text-sm font-medium">{step}</p>
                    {/* The sign-in page may ask for an organization; nothing reads that choice. */}
                    {index === 0 && <p className="text-muted-foreground text-xs">{SIGN_IN_NOTE}</p>}
                  </div>
                </li>
              ))}
            </ol>
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
 * their access, then the denied ones. Add shows a prompt to give the assistant (the
 * address under it, for adding the connector by hand) and what to do after.
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
  // so its row, at the top of the list, is what they see. The baseline is the
  // first loaded list after it opens (`createDialogArrivalWatch`).
  const arrivalWatch = useRef<ReturnType<typeof createDialogArrivalWatch> | null>(null);
  const waitingIds = assistants.filter((a) => a.access === "pending").map((a) => a.clientId);
  const waitingKey = waitingIds.join(",");
  const loaded = assistantsQuery.isSuccess;
  useEffect(() => {
    if (!dialogOpen) {
      arrivalWatch.current = null;
      return;
    }
    arrivalWatch.current ??= createDialogArrivalWatch();
    if (arrivalWatch.current(loaded ? waitingIds : undefined)) setDialogOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- waitingKey stands for waitingIds
  }, [dialogOpen, waitingKey, loaded]);

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

      {/* Arrival toasts are not shown on this page: a new request is announced here. */}
      <p className="sr-only" role="status" aria-live="polite">
        {waitingAnnouncement(waitingIds.length)}
      </p>

      {assistantsQuery.isError ? (
        <p className="text-muted-foreground py-0.5 text-sm">Couldn&apos;t load assistants.</p>
      ) : assistantsQuery.isSuccess && assistants.length === 0 ? (
        <p className="text-muted-foreground py-0.5 text-sm">No assistants yet.</p>
      ) : (
        <div className="space-y-1.5">
          {assistants.map((assistant) => {
            // One change at a time: while any is pending, every row's controls wait.
            const busy = busyId !== null;
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
