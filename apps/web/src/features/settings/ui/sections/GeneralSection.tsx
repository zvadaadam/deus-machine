import { useState, useEffect } from "react";
import { match } from "ts-pattern";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { RotateCcw, Loader2, RefreshCw, CheckCircle2, AlertCircle, Download } from "lucide-react";
import { useUIStore } from "@/shared/stores/uiStore";
import { setAnalyticsEnabled } from "@/platform/analytics";
import { capabilities } from "@/platform";
import { useUpdateContext } from "@/features/updates";
import type { GeneralSectionProps } from "./types";

export function GeneralSection({ settings, saveSetting, theme, setTheme }: GeneralSectionProps) {
  const closeSettings = useUIStore((s) => s.closeSettings);
  const updateCtx = useUpdateContext();
  const [currentVersion, setCurrentVersion] = useState<string>(__APP_VERSION__);
  const [manualChecking, setManualChecking] = useState(false);
  const [manualResult, setManualResult] = useState<"up-to-date" | null>(null);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI
        .getAppVersion()
        .then(setCurrentVersion)
        .catch(() => {
          /* Expected: electronAPI may exist but getAppVersion can fail in non-Electron environments */
        });
    }
  }, []);

  useEffect(() => {
    if (manualResult !== "up-to-date") return;
    const timer = setTimeout(() => setManualResult(null), 3000);
    return () => clearTimeout(timer);
  }, [manualResult]);

  async function handleCheckForUpdates() {
    if (!updateCtx) return;
    setManualChecking(true);
    setManualResult(null);
    try {
      const isUpToDate = await updateCtx.check();
      if (isUpToDate) {
        setManualResult("up-to-date");
      }
    } finally {
      setManualChecking(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">General</h3>
        <p className="text-muted-foreground mt-1 text-base">Appearance and display preferences.</p>
      </div>

      {/* Theme */}
      <div className="space-y-2">
        <Label htmlFor="theme" className="text-sm">
          Theme
        </Label>
        <Select
          value={theme}
          onValueChange={(value: "light" | "dark" | "system") => setTheme(value)}
        >
          <SelectTrigger id="theme" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="dark">Dark</SelectItem>
            <SelectItem value="system">System</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Separator />

      {/* Diff view mode */}
      <div className="space-y-2">
        <Label htmlFor="diff-view" className="text-sm">
          Diff view mode
        </Label>
        <p className="text-muted-foreground text-base">
          How file changes are displayed in the diff viewer.
        </p>
        <Select
          value={settings.diff_view_mode ?? "unified"}
          onValueChange={(value) => saveSetting("diff_view_mode", value)}
        >
          <SelectTrigger id="diff-view" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unified">Unified</SelectItem>
            <SelectItem value="split">Split</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Separator />

      {/* Replay onboarding — desktop only (requires Electron window effects) */}
      {capabilities.nativeOnboarding && (
        <>
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Onboarding</Label>
              <p className="text-muted-foreground text-base">Replay the setup walkthrough.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const ok = await saveSetting("onboarding_completed", false);
                if (ok) closeSettings();
              }}
            >
              <RotateCcw className="mr-1.5 size-3.5" />
              Replay
            </Button>
          </div>

          <Separator />
        </>
      )}

      {/* Analytics */}
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="analytics-toggle" className="text-sm">
            Usage analytics
          </Label>
          <p className="text-muted-foreground text-base">
            Help improve Deus by sharing anonymous usage data.
          </p>
        </div>
        <Switch
          id="analytics-toggle"
          checked={settings.analytics_enabled !== false}
          onCheckedChange={async (checked) => {
            setAnalyticsEnabled(checked);
            const ok = await saveSetting("analytics_enabled", checked);
            if (!ok) setAnalyticsEnabled(!checked);
          }}
        />
      </div>

      {/* Updates — desktop only */}
      {capabilities.autoUpdate && (
        <>
          <Separator />

          <div className="space-y-2">
            <Label className="text-sm">Version</Label>
            <p className="text-foreground flex items-center gap-2 font-mono text-base">
              {currentVersion ? `v${currentVersion}` : "Loading..."}
              {import.meta.env.DEV && (
                <span className="bg-warning/15 text-warning rounded px-1.5 py-0.5 text-xs font-semibold">
                  DEV
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Check for updates</Label>
              <p className="text-muted-foreground text-base">
                Updates are checked automatically every 5 minutes.
              </p>
            </div>
            {(() => {
              const isChecking = manualChecking || updateCtx?.state.stage === "checking";
              return (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCheckForUpdates}
                  disabled={isChecking || updateCtx?.state.stage === "downloading"}
                >
                  {isChecking ? (
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1.5 size-3.5" />
                  )}
                  {isChecking ? "Checking..." : "Check now"}
                </Button>
              );
            })()}
          </div>

          {updateCtx &&
            match(updateCtx.state.stage)
              .with("ready", () => (
                <div className="bg-primary/5 border-primary/20 flex items-center justify-between rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <Download className="text-primary size-4" />
                    <span className="text-sm">
                      Update <span className="font-semibold">v{updateCtx.state.version}</span> is
                      ready
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
              .with("idle", () => null)
              .with("checking", () => null)
              .exhaustive()}

          {manualResult === "up-to-date" && (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <CheckCircle2 className="text-success size-3.5" />
              <span>You're on the latest version.</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
