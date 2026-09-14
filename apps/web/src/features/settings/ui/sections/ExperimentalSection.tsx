import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { useSimulatorCapabilities } from "@/features/simulator";
import type { SettingsSectionProps } from "./types";

export function ExperimentalSection({ settings, saveSetting }: SettingsSectionProps) {
  const simulatorCapabilities = useSimulatorCapabilities();
  const simulatorUnavailableReason =
    simulatorCapabilities.data.available === false
      ? simulatorCapabilities.data.unavailableReason
      : null;
  const simulatorSwitchDisabled =
    settings.experimental_simulator !== true && simulatorCapabilities.data.available === false;

  return (
    <FieldGroup className="gap-5">
      <div>
        <h3 className="text-base font-semibold">Experimental</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Early-access features that are still in development.
        </p>
      </div>

      {/* iOS Simulator */}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="experimental-simulator" className="text-sm">
            iOS Simulator
          </FieldLabel>
          <FieldDescription>
            {simulatorUnavailableReason ??
              "Let the AI agent interact with and test on iOS simulators."}
          </FieldDescription>
        </FieldContent>
        <Switch
          id="experimental-simulator"
          checked={settings.experimental_simulator === true}
          disabled={simulatorSwitchDisabled}
          onCheckedChange={(checked) => saveSetting("experimental_simulator", checked)}
        />
      </Field>

      <Separator />

      {/* Browser */}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="experimental-browser" className="text-sm">
            Browser
          </FieldLabel>
          <FieldDescription>
            Let the AI agent use a browser to test and develop websites.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="experimental-browser"
          checked={settings.experimental_browser === true}
          onCheckedChange={(checked) => saveSetting("experimental_browser", checked)}
        />
      </Field>

      <Separator />

      {/* Apps */}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="experimental-apps" className="text-sm">
            Apps
          </FieldLabel>
          <FieldDescription>Launch and manage agentic apps inside the workspace.</FieldDescription>
        </FieldContent>
        <Switch
          id="experimental-apps"
          checked={settings.experimental_apps === true}
          onCheckedChange={(checked) => saveSetting("experimental_apps", checked)}
        />
      </Field>
    </FieldGroup>
  );
}
