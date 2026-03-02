import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
import { RotateCcw } from "lucide-react";
import { useUIStore } from "@/shared/stores/uiStore";
import { setAnalyticsEnabled } from "@/platform/analytics";
import type { GeneralSectionProps } from "./types";

export function GeneralSection({ settings, saveSetting, theme, setTheme }: GeneralSectionProps) {
  const closeSettings = useUIStore((s) => s.closeSettings);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">General</h3>
        <p className="text-muted-foreground mt-1 text-base">
          Profile, appearance, and display preferences.
        </p>
      </div>

      {/* Name */}
      <div className="space-y-2">
        <Label htmlFor="user-name" className="text-sm">
          Name
        </Label>
        <Input
          id="user-name"
          defaultValue={settings.user_name ?? ""}
          onBlur={(e) => saveSetting("user_name", e.currentTarget.value)}
          placeholder="Your name"
        />
      </div>

      <Separator />

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

      {/* Replay onboarding */}
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

      {/* Analytics */}
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="analytics-toggle" className="text-sm">
            Usage analytics
          </Label>
          <p className="text-muted-foreground text-base">
            Help improve OpenDevs by sharing anonymous usage data.
          </p>
        </div>
        <Switch
          id="analytics-toggle"
          checked={settings.analytics_enabled !== false}
          onCheckedChange={(checked) => {
            saveSetting("analytics_enabled", checked);
            setAnalyticsEnabled(checked);
          }}
        />
      </div>
    </div>
  );
}
