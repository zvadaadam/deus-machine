import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import type { GeneralSectionProps } from './types';

export function GeneralSection({ settings, saveSetting, theme, setTheme }: GeneralSectionProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">General Settings</h3>

      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="theme">Theme</Label>
          <Select
            value={theme}
            onValueChange={(value: 'light' | 'dark' | 'system') => setTheme(value)}
          >
            <SelectTrigger id="theme">
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

        <div className="flex items-center space-x-2">
          <Checkbox
            id="notifications"
            checked={settings.notifications_enabled ?? true}
            onCheckedChange={(checked) => saveSetting('notifications_enabled', checked === true)}
          />
          <Label htmlFor="notifications" className="text-sm cursor-pointer">
            Enable notifications
          </Label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="sound-effects"
            checked={settings.sound_effects_enabled ?? true}
            onCheckedChange={(checked) => saveSetting('sound_effects_enabled', checked === true)}
          />
          <Label htmlFor="sound-effects" className="text-sm cursor-pointer">
            Enable sound effects
          </Label>
        </div>

        <div className="space-y-2">
          <Label htmlFor="sound-type">Sound type</Label>
          <Select
            value={settings.sound_type ?? 'choo-choo'}
            onValueChange={(value) => saveSetting('sound_type', value)}
          >
            <SelectTrigger id="sound-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="choo-choo">Choo Choo</SelectItem>
              <SelectItem value="beep">Beep</SelectItem>
              <SelectItem value="chime">Chime</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="diff-view">Diff view mode</Label>
          <Select
            value={settings.diff_view_mode ?? 'unified'}
            onValueChange={(value) => saveSetting('diff_view_mode', value)}
          >
            <SelectTrigger id="diff-view">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unified">Unified</SelectItem>
              <SelectItem value="split">Split</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
