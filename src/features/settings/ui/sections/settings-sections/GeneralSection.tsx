import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SettingRow } from "../../SettingsModal";
import type { GeneralSectionProps } from "./types";

export function GeneralSection({ settings, saveSetting, theme, setTheme }: GeneralSectionProps) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">General</h3>
        <p className="text-muted-foreground mt-1 text-[13px]">
          Appearance, notifications, and display preferences.
        </p>
      </div>

      {/* Appearance */}
      <div className="space-y-3">
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
      </div>

      <Separator />

      {/* Notifications & Sound */}
      <div className="space-y-1">
        <SettingRow
          id="notifications"
          label="Notifications"
          description="Get notified when agents complete tasks or need attention."
        >
          <Switch
            id="notifications"
            checked={settings.notifications_enabled ?? true}
            onCheckedChange={(checked) => saveSetting("notifications_enabled", checked)}
          />
        </SettingRow>

        <SettingRow
          id="sound-effects"
          label="Sound effects"
          description="Play audio cues for agent events."
        >
          <Switch
            id="sound-effects"
            checked={settings.sound_effects_enabled ?? true}
            onCheckedChange={(checked) => saveSetting("sound_effects_enabled", checked)}
          />
        </SettingRow>
      </div>

      {settings.sound_effects_enabled !== false && (
        <div className="space-y-2">
          <Label htmlFor="sound-type" className="text-sm">
            Sound type
          </Label>
          <Select
            value={settings.sound_type ?? "choo-choo"}
            onValueChange={(value) => saveSetting("sound_type", value)}
          >
            <SelectTrigger id="sound-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="choo-choo">Choo Choo</SelectItem>
              <SelectItem value="beep">Beep</SelectItem>
              <SelectItem value="chime">Chime</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <Separator />

      {/* Diff */}
      <div className="space-y-2">
        <Label htmlFor="diff-view" className="text-sm">
          Diff view mode
        </Label>
        <p className="text-muted-foreground text-[13px]">
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
    </div>
  );
}
