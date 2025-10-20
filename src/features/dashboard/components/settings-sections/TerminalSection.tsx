import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { SettingsSectionProps } from './types';

export function TerminalSection({ settings, saveSetting }: SettingsSectionProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Terminal Settings</h3>

      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="font-size">Font size</Label>
          <Input
            id="font-size"
            type="number"
            min="8"
            max="24"
            value={settings.terminal_font_size ?? 12}
            onChange={(e) => {
              const value = parseInt(e.target.value, 10);
              const fontSize = isNaN(value) || value < 8 || value > 24 ? 12 : value;
              saveSetting('terminal_font_size', fontSize);
            }}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="default-editor">Default editor</Label>
          <Select
            value={settings.default_open_in ?? 'cursor'}
            onValueChange={(value) => saveSetting('default_open_in', value)}
          >
            <SelectTrigger id="default-editor">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cursor">Cursor</SelectItem>
              <SelectItem value="vscode">VS Code</SelectItem>
              <SelectItem value="sublime">Sublime Text</SelectItem>
              <SelectItem value="vim">Vim</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
