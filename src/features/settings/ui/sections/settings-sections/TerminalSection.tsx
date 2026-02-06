import { useEffect, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { SettingsSectionProps } from "./types";

export function TerminalSection({ settings, saveSetting }: SettingsSectionProps) {
  const [fontSize, setFontSize] = useState(settings.terminal_font_size ?? 12);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce saveSetting for font size
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      if (fontSize !== settings.terminal_font_size) {
        saveSetting("terminal_font_size", fontSize);
      }
    }, 500);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [fontSize, settings.terminal_font_size, saveSetting]);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Terminal</h3>
        <p className="text-muted-foreground mt-1 text-[13px]">
          Terminal appearance and editor integration.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="font-size" className="text-sm">
          Font size
        </Label>
        <p className="text-muted-foreground text-[13px]">Size in pixels (8 - 24).</p>
        <Input
          id="font-size"
          type="number"
          min="8"
          max="24"
          step="1"
          className="w-24"
          value={fontSize}
          onChange={(e) => {
            const value = parseInt(e.target.value, 10);
            const newFontSize = isNaN(value) || value < 8 || value > 24 ? 12 : value;
            setFontSize(newFontSize);
          }}
        />
      </div>

      <Separator />

      <div className="space-y-2">
        <Label htmlFor="default-editor" className="text-sm">
          Default editor
        </Label>
        <p className="text-muted-foreground text-[13px]">
          Which editor to use when opening files from the app.
        </p>
        <Select
          value={settings.default_open_in ?? "cursor"}
          onValueChange={(value) => saveSetting("default_open_in", value)}
        >
          <SelectTrigger id="default-editor" className="w-full">
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
  );
}
