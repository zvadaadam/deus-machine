import { useState, useEffect } from "react";
import { match } from "ts-pattern";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, RefreshCw, CheckCircle2, AlertCircle, Download } from "lucide-react";
import { useUpdateContext } from "@/features/updates";
import { isTauriEnv } from "@/platform/tauri";

export function UpdateSection() {
  const updateCtx = useUpdateContext();
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [manualChecking, setManualChecking] = useState(false);
  const [manualResult, setManualResult] = useState<"up-to-date" | null>(null);

  // Fetch current app version
  useEffect(() => {
    if (!isTauriEnv) {
      setCurrentVersion("dev");
      return;
    }
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion("unknown"));
  }, []);

  async function handleCheckForUpdates() {
    if (!updateCtx) return;
    setManualChecking(true);
    setManualResult(null);

    await updateCtx.check();

    // If still idle after check, we're up to date
    setManualChecking(false);
    if (updateCtx.state.stage === "idle") {
      setManualResult("up-to-date");
      // Auto-dismiss the "up to date" message after 3s
      setTimeout(() => setManualResult(null), 3000);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Updates</h3>
        <p className="text-muted-foreground mt-1 text-base">App version and update management.</p>
      </div>

      {/* Current version */}
      <div className="space-y-2">
        <Label className="text-sm">Version</Label>
        <p className="text-foreground font-mono text-base">
          {currentVersion ? `v${currentVersion}` : "Loading..."}
        </p>
      </div>

      <Separator />

      {/* Check for updates */}
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm">Check for updates</Label>
          <p className="text-muted-foreground text-base">
            Updates are checked automatically every 5 minutes.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCheckForUpdates}
          disabled={manualChecking || updateCtx?.state.stage === "downloading"}
        >
          {manualChecking ? (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 size-3.5" />
          )}
          {manualChecking ? "Checking..." : "Check now"}
        </Button>
      </div>

      {/* Status messages */}
      {updateCtx &&
        match(updateCtx.state.stage)
          .with("ready", () => (
            <div className="bg-primary/5 border-primary/20 flex items-center justify-between rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <Download className="text-primary size-4" />
                <span className="text-sm">
                  Update <span className="font-semibold">v{updateCtx.state.version}</span> is ready
                </span>
              </div>
              <Button size="sm" onClick={() => void updateCtx.install()}>
                Restart to update
              </Button>
            </div>
          ))
          .with("downloading", () => (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-3.5 animate-spin" />
              <span>Downloading update...</span>
            </div>
          ))
          .with("error", () => (
            <div className="text-destructive flex items-center gap-2 text-sm">
              <AlertCircle className="size-3.5" />
              <span>Update check failed: {updateCtx.state.error}</span>
            </div>
          ))
          .otherwise(() => null)}

      {/* Manual check result: up to date */}
      {manualResult === "up-to-date" && (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <CheckCircle2 className="text-success size-3.5" />
          <span>You're on the latest version.</span>
        </div>
      )}
    </div>
  );
}
