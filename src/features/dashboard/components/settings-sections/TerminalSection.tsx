import { useEffect, useRef, useState } from 'react';
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
  const [fontSize, setFontSize] = useState(settings.terminal_font_size ?? 12);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync if settings update externally
  useEffect(() => {
    setFontSize(settings.terminal_font_size ?? 12);
  }, [settings.terminal_font_size]);

  // Debounce saveSetting for font size
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      if (fontSize !== settings.terminal_font_size) {
        saveSetting('terminal_font_size', fontSize);
      }
    }, 500);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [fontSize, settings.terminal_font_size, saveSetting]);

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
            step="1"
            value={fontSize}
            onChange={(e) => {
              const value = parseInt(e.target.value, 10);
              const newFontSize = isNaN(value) || value < 8 || value > 24 ? 12 : value;
              setFontSize(newFontSize);
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
