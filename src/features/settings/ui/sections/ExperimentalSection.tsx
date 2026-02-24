import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import type { SettingsSectionProps } from "./types";

export function ExperimentalSection({ settings, saveSetting }: SettingsSectionProps) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Experimental</h3>
        <p className="text-muted-foreground mt-1 text-base">
          Early-access features that are still in development.
        </p>
      </div>

      {/* iOS Simulator */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="experimental-simulator" className="text-sm">
            iOS Simulator
          </Label>
          <p className="text-muted-foreground text-base">
            Stream and interact with iOS simulators in the IDE.
          </p>
        </div>
        <Switch
          id="experimental-simulator"
          checked={settings.experimental_simulator !== false}
          onCheckedChange={(checked) => saveSetting("experimental_simulator", checked)}
        />
      </div>

      <Separator />

      {/* Browser */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="experimental-browser" className="text-sm">
            Browser
          </Label>
          <p className="text-muted-foreground text-base">
            Built-in browser with DevTools and cookie sync.
          </p>
        </div>
        <Switch
          id="experimental-browser"
          checked={settings.experimental_browser !== false}
          onCheckedChange={(checked) => saveSetting("experimental_browser", checked)}
        />
      </div>
    </div>
  );
}
