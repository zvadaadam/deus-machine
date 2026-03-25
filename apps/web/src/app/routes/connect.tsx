/**
 * ConnectPage -- server connection / pairing entry point for web mode.
 *
 * Phase 1: Simple page that lets the user enter a server ID to navigate to /s/{id}.
 * Phase 2: Will integrate relay connectivity, pairing flow, server status checks.
 *
 * Supports both /connect and /connect/$serverId (pre-filled from a shared link).
 */

import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ConnectPage() {
  // $serverId may be present if navigated to /connect/$serverId
  const params = useParams({ strict: false }) as { serverId?: string };
  const navigate = useNavigate();
  const [serverId, setServerId] = useState(params.serverId ?? "");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = serverId.trim();
    if (!trimmed) {
      setError("Please enter a server ID");
      return;
    }
    setError(null);
    navigate({ to: "/s/$serverId", params: { serverId: trimmed } });
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">Connect to Server</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Enter the server ID from your Deus desktop app to connect.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Server ID</Label>
            <Input
              type="text"
              placeholder="e.g. abc123"
              value={serverId}
              onChange={(e) => {
                setServerId(e.target.value);
                setError(null);
              }}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="text-center font-mono text-lg tracking-wider"
            />
          </div>

          {error && <p className="text-destructive text-center text-sm">{error}</p>}

          <Button type="submit" className="w-full" disabled={!serverId.trim()}>
            Connect
          </Button>
        </form>

        {/* Help text */}
        <p className="text-muted-foreground text-center text-xs">
          Open Settings &gt; Remote Access in the Deus desktop app to find your server ID.
        </p>
      </div>
    </div>
  );
}
