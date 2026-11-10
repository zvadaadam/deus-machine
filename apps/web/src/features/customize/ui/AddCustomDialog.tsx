/**
 * AddCustomDialog — bring your own: an MCP server (remote URL or a local
 * command) becomes an app like any other; a GitHub link to a skill folder
 * becomes a skill. Both reach every agent, like catalog items.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Textarea,
} from "@/components/ui";
import { cn } from "@/shared/lib/utils";
import type { AppAuth, CustomAppInput } from "@shared/integrations/types";
import { useAddCustomApp, useAddCustomSkill } from "../api/integrations.queries";
import { Field } from "./DetailPage";

export type AddCustomMode = "mcp" | "skill";

type ServerKind = "remote" | "local";
type RemoteAuth = "oauth" | "bearer" | "none";

export function AddCustomDialog({
  mode,
  onClose,
  onAdded,
}: {
  mode: AddCustomMode;
  onClose: () => void;
  onAdded: (kind: "app" | "skill", id: string) => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex flex-col gap-5 sm:max-w-md">
        {mode === "mcp" ? (
          <McpForm onAdded={(id) => onAdded("app", id)} />
        ) : (
          <SkillForm onAdded={(id) => onAdded("skill", id)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="bg-bg-elevated flex w-fit gap-0.5 rounded-lg p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "control-interaction rounded-md px-2.5 py-1 text-xs",
            value === option.value
              ? "bg-bg-surface text-text-primary font-medium shadow-sm"
              : "text-text-tertiary hover:text-text-secondary"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function McpForm({ onAdded }: { onAdded: (id: string) => void }) {
  const add = useAddCustomApp();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ServerKind>("remote");
  const [url, setUrl] = useState("");
  const [authKind, setAuthKind] = useState<RemoteAuth>("oauth");
  const [command, setCommand] = useState("");
  const [variables, setVariables] = useState("");

  /** `NAME=value` lines; the names become the app's settings, the values go to the vault. */
  const env = variables
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf("=");
      return at > 0 ? { name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() } : null;
    });
  const envValid = env.every((entry) => entry !== null && /^[A-Z_][A-Z0-9_]*$/.test(entry.name));

  const submit = () => {
    let input: CustomAppInput;
    let values: Record<string, string> | undefined;
    if (kind === "remote") {
      const auth: AppAuth =
        authKind === "bearer"
          ? { kind: "bearer", label: "Access token" }
          : authKind === "oauth"
            ? { kind: "oauth" }
            : { kind: "none" };
      input = { name, transport: { type: "http", url: url.trim() }, auth };
    } else {
      const [cmd, ...args] = command.trim().split(/\s+/);
      const vars = env.flatMap((entry) => (entry ? [entry] : []));
      input = {
        name,
        transport: { type: "stdio", command: cmd ?? "", args },
        auth: vars.length
          ? { kind: "env", vars: vars.map(({ name }) => ({ name, label: name })) }
          : { kind: "none" },
      };
      if (vars.length) values = Object.fromEntries(vars.map(({ name, value }) => [name, value]));
    }
    add.mutate(
      { input, values },
      {
        onSuccess: (result) => onAdded(result.appId),
      }
    );
  };

  const valid =
    name.trim().length > 0 &&
    (kind === "remote"
      ? /^https?:\/\/\S+$/.test(url.trim())
      : command.trim().length > 0 && envValid);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <DialogTitle className="text-base">Add an MCP server</DialogTitle>
        <DialogDescription className="text-text-tertiary text-xs">
          It becomes an app every agent can use, in every project.
        </DialogDescription>
      </div>
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme API"
          autoFocus
        />
      </Field>
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          { value: "remote", label: "Remote (URL)" },
          { value: "local", label: "Local (command)" },
        ]}
      />
      {kind === "remote" ? (
        <>
          <Field label="Server URL">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
            />
          </Field>
          <Field label="Sign-in">
            <Segmented
              value={authKind}
              onChange={setAuthKind}
              options={[
                { value: "oauth", label: "OAuth" },
                { value: "bearer", label: "Token" },
                { value: "none", label: "None" },
              ]}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="Command">
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx -y @acme/mcp-server"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Keys and settings (optional)">
            <Textarea
              value={variables}
              onChange={(e) => setVariables(e.target.value)}
              placeholder={"ACME_API_KEY=…\nACME_REGION=eu"}
              spellCheck={false}
              rows={3}
              className="font-mono text-xs"
            />
            <span className="text-text-muted text-xs">
              One NAME=value per line. Stored encrypted and given to the server when it starts; keep
              keys out of the command itself.
            </span>
          </Field>
        </>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!valid || add.isPending}>
          {add.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Add server
        </Button>
      </div>
    </form>
  );
}

function SkillForm({ onAdded }: { onAdded: (id: string) => void }) {
  const add = useAddCustomSkill();
  const [source, setSource] = useState("");
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!source.trim()) return;
        add.mutate(source, {
          onSuccess: (result) => onAdded(result.skillId),
        });
      }}
    >
      <div className="flex flex-col gap-1">
        <DialogTitle className="text-base">Add a skill from GitHub</DialogTitle>
        <DialogDescription className="text-text-tertiary text-xs">
          Paste a link to a folder with a SKILL.md. Deus pins the commit it installs.
        </DialogDescription>
      </div>
      <Field label="GitHub link">
        <Input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="https://github.com/owner/repo/tree/main/skills/my-skill"
          spellCheck={false}
          autoFocus
        />
      </Field>
      <p className="text-text-muted text-xs leading-relaxed">
        Skills can include scripts the agent may run. Add skills from sources you trust.
      </p>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!source.trim() || add.isPending}>
          {add.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {add.isPending ? "Fetching…" : "Add skill"}
        </Button>
      </div>
    </form>
  );
}
