import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { finishLocalSignIn } from "../../lib/local-agent-login";

/** A sign-in that finishes with the code its page shows (Claude's, from another device). */
export function LoginCodeForm({ loginId }: { loginId: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!code.trim()) return;
        setBusy(true);
        void finishLocalSignIn(loginId, code.trim()).finally(() => setBusy(false));
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
  );
}
